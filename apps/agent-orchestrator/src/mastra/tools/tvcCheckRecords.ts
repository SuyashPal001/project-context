// Part A kept two TVC check records in process memory: check_still's passed
// stills and check_clip's re-check guard. A pm2 restart forgot both. They now
// live in the conversation thread's metadata, through Mastra's own
// Memory.getThreadById / updateThread on the existing PostgresStore — no new
// table (spec 2026-10-05-tvc-jingle-design.md K1).
//
// Which memory: getOlmoMemory(), the instance that owns the user's
// conversation thread. Never getMastraMemory(), and never a scope change —
// see the cross-tenant warning above getOlmoMemory in ../memory.ts.
//
// Write guard: a thread is read or written only when it exists and its
// resourceId is this request's tenant. Anything else falls back to today's
// behaviour (a still is "not checked"; the re-check guard uses process memory).

export type CheckInputs = { expectedLine: boolean; product: boolean; reference: boolean; noSpeech?: boolean; presenter?: boolean; productVisible?: boolean; extras?: boolean; lead?: boolean; action?: boolean; endState?: boolean; productNarrow?: boolean; productExpectedState?: boolean }

export interface CheckScope { threadId: string; resourceId: string }
// checkedOrder holds the clip ids oldest first: thread metadata is a jsonb
// column, which does not keep object key order.
export interface TvcCheckRecords { passedStills: string[]; checkedWith: Record<string, CheckInputs>; checkedOrder: string[] }
export interface StoredThread { id: string; resourceId: string; metadata?: Record<string, unknown> | null }
export interface ThreadMetaStore {
  getThreadById(args: { threadId: string }): Promise<StoredThread | null>
  updateThread(args: { id: string; metadata: Record<string, unknown> }): Promise<unknown>
}

export const MAX_CHECK_RECORDS = 200
const RECORDS_KEY = 'tvcChecks'

let storeOverride: ThreadMetaStore | null = null
/** Tests only: swap in an in-memory store (tvcCheckRecords.testing.ts). */
export function setCheckRecordStore(store: ThreadMetaStore | null): void { storeOverride = store }

async function threadStore(): Promise<ThreadMetaStore> {
  if (storeOverride) return storeOverride
  const { getOlmoMemory } = await import('../memory.js')
  const memory = getOlmoMemory()
  return {
    getThreadById: ({ threadId }) => memory.getThreadById({ threadId }),
    // Only our key is sent: @mastra/pg merges top-level metadata, so the
    // title and working memory are kept and never rewritten from a stale read.
    updateThread: ({ id, metadata }) => memory.updateThread({ id, metadata }),
  }
}

/** The conversation thread (= the Mastra thread id chatStream streams with) and the tenant. */
export function checkScopeOf(rc: { get: (key: string) => unknown } | undefined): CheckScope {
  return { threadId: (rc?.get('conversationId') as string | undefined) ?? '', resourceId: (rc?.get('tenantId') as string | undefined) ?? '' }
}

export function readRecords(metadata: Record<string, unknown> | null | undefined): TvcCheckRecords {
  const raw = (metadata?.[RECORDS_KEY] ?? {}) as Partial<TvcCheckRecords>
  const passedStills = Array.isArray(raw.passedStills) ? raw.passedStills.filter((s): s is string => typeof s === 'string') : []
  const checkedWith = raw.checkedWith && typeof raw.checkedWith === 'object' && !Array.isArray(raw.checkedWith) ? { ...raw.checkedWith } : {}
  const order = Array.isArray(raw.checkedOrder) ? raw.checkedOrder.filter((k): k is string => typeof k === 'string' && k in checkedWith) : []
  const checkedOrder = [...order, ...Object.keys(checkedWith).filter((k) => !order.includes(k))]
  return { passedStills, checkedWith, checkedOrder }
}

export function capRecords(r: TvcCheckRecords): TvcCheckRecords {
  const checkedOrder = r.checkedOrder.slice(-MAX_CHECK_RECORDS)
  return {
    passedStills: r.passedStills.slice(-MAX_CHECK_RECORDS),
    checkedOrder,
    checkedWith: Object.fromEntries(checkedOrder.map((k) => [k, r.checkedWith[k]])),
  }
}

async function ownedThread(scope: CheckScope): Promise<StoredThread | null> {
  if (!scope.threadId || !scope.resourceId) return null
  try {
    const thread = await (await threadStore()).getThreadById({ threadId: scope.threadId })
    return thread && thread.resourceId === scope.resourceId ? thread : null
  } catch (err) {
    console.warn('[tvcCheckRecords] thread read failed:', (err as Error).message)
    return null
  }
}

export async function loadCheckRecords(scope: CheckScope): Promise<TvcCheckRecords | null> {
  const thread = await ownedThread(scope)
  return thread ? readRecords(thread.metadata) : null
}

// Parallel tool calls in one thread (Director checks several stills at once)
// would each read, change and write: one process, so a promise chain per
// thread serialises them (same pattern as planTvc's withPlanLock).
const threadLocks = new Map<string, Promise<void>>()
async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(threadId) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  threadLocks.set(threadId, tail)
  try {
    return await run
  } finally {
    if (threadLocks.get(threadId) === tail) threadLocks.delete(threadId)
  }
}

/** Read–merge–write. change returns null to write nothing. */
export async function updateCheckRecords(scope: CheckScope, change: (r: TvcCheckRecords) => TvcCheckRecords | null): Promise<'written' | 'unchanged' | 'unavailable'> {
  return withThreadLock(scope.threadId, async () => {
    const thread = await ownedThread(scope)
    if (!thread) return 'unavailable'
    const next = change(readRecords(thread.metadata))
    if (!next) return 'unchanged'
    try {
      await (await threadStore()).updateThread({ id: scope.threadId, metadata: { [RECORDS_KEY]: capRecords(next) } })
      return 'written'
    } catch (err) {
      console.warn('[tvcCheckRecords] thread write failed:', (err as Error).message)
      return 'unavailable'
    }
  })
}
