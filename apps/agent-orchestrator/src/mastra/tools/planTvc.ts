import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { uploadFileWithKey } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { computeCreditPlan, priceFromRates, readBalanceForTenant } from './checkCreditPlan.js'
import { recordOnPlan, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, jingleErrors, type TvcPlan } from './tvcPlan.js'
import { stillPassedCheck } from './checkStill.js'

// The TVC ad's plan lives in ONE file whose id never changes: it is always
// re-uploaded to the same storage key, and /files/:id/confirm keeps the
// original row (persistence.ts uploadFileWithKey). Delegations then carry only
// "TVC plan: <id>" and a step — the plan itself never rides in a prompt.
export interface SavedPlan { version: 1; storageKey: string; plan: TvcPlan }

export interface PlanTvcDeps {
  load: (planFileId: string) => Promise<SavedPlan>
  save: (doc: SavedPlan) => Promise<string | null>
  price: (plan: TvcPlan) => Promise<{ fullCostCredits: number; shortfallCredits: number }>
  newKey: () => string
  stillChecked: (stillFileId: string) => boolean
}

export const planTvcInputSchema = z.object({
  action: z.enum(['check', 'get', 'record']).describe('check: validate and save the plan; get: read one slice; record: attach finished stills or clips to their shots, or the finish\'s narration, song and jingle to the plan'),
  plan: tvcPlanSchema.optional().describe('check only: the full plan'),
  planFileId: z.string().optional().describe('The TVC plan id. Required for get and record; pass it on a re-check so the plan keeps its id'),
  slice: z.string().optional().describe('get only: "brief", "finish" or "shots a-b", e.g. "shots 4-6"'),
  shot: z.number().int().min(1).optional().describe('record only: the shot number'),
  stillFileId: z.string().optional().describe('record only: the shot\'s approved still'),
  clipFileId: z.string().optional().describe('record only: the shot\'s checked, trimmed clip'),
  records: z.array(z.object({
    shot: z.number().int().min(1),
    stillFileId: z.string().optional(),
    clipFileId: z.string().optional(),
    keptByUser: z.boolean().optional().describe('The user chose to keep this still although its check failed'),
  })).optional().describe('record only: every still or clip a step made, in one call'),
  narrationFileIds: z.array(z.string()).optional().describe('record only: the finish\'s narration, one per voiceover block, in order'),
  songFileId: z.string().optional().describe('record only: the finish\'s music bed'),
  jingleFileId: z.string().optional().describe('record only: generate_jingle\'s fileId (the full sung clip)'),
  signoffFileId: z.string().optional().describe('record only: generate_jingle\'s signoffFileId'),
  signoffSeconds: z.number().positive().optional().describe('record only: generate_jingle\'s signoffSeconds'),
  keptByUser: z.boolean().optional().describe('record only, single-shot form: the user chose to keep this still although its check failed'),
})
export type PlanTvcInput = z.infer<typeof planTvcInputSchema>

export interface PlanTvcOutput {
  planFileId?: string
  errors?: string[]
  warnings?: string[]
  costCredits?: number
  shortfallCredits?: number
  slice?: string
  refused?: boolean
  refusalReason?: string
}

// Recorded stills and clips survive a re-check for shots whose content did not
// change. The narration survives while the voiceover and the voice are the
// same; the song while the tier and the category are (what it was chosen for).
function carryOver(previous: TvcPlan, next: TvcPlan): TvcPlan {
  const out = structuredClone(next)
  const sameVoiceover = JSON.stringify(previous.voiceover) === JSON.stringify(next.voiceover) && previous.brief.voiceId === next.brief.voiceId
  out.narrationFileIds = sameVoiceover ? previous.narrationFileIds : undefined
  const sameMusic = previous.brief.tier === next.brief.tier && previous.brief.category === next.brief.category
  out.songFileId = sameMusic ? previous.songFileId : undefined
  // The recorded jingle survives while the jingle asked for is the same and
  // still fits the (possibly changed) voiceover; otherwise it must be re-made.
  delete out.jingleFileId; delete out.signoffFileId; delete out.signoffSeconds
  const sameJingle = !!next.brief.jingle && JSON.stringify(previous.brief.jingle) === JSON.stringify(next.brief.jingle)
  if (sameJingle && previous.signoffSeconds !== undefined && jingleErrors(out, previous.signoffSeconds).length === 0) {
    out.jingleFileId = previous.jingleFileId
    out.signoffFileId = previous.signoffFileId
    out.signoffSeconds = previous.signoffSeconds
  }
  const strip = (s: TvcPlan['shots'][number]) => JSON.stringify({ ...s, stillFileId: undefined, clipFileId: undefined })
  out.shots.forEach((s) => {
    const before = previous.shots.find((p) => p.n === s.n)
    if (before && strip(before) === strip(s) && !s.stillFileId && !s.clipFileId) {
      if (before.stillFileId) s.stillFileId = before.stillFileId
      if (before.clipFileId) s.clipFileId = before.clipFileId
    }
  })
  return out
}

// Director can record several shots at once (parallel tool calls), and each
// record is load -> modify -> save of the same file: without a lock the last
// save wins and the other shots' files are lost. One orchestrator process, so
// an in-memory promise chain per plan id is enough.
const planLocks = new Map<string, Promise<void>>()
async function withPlanLock<T>(planFileId: string, fn: () => Promise<T>): Promise<T> {
  const previous = planLocks.get(planFileId) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  planLocks.set(planFileId, tail)
  try {
    return await run
  } finally {
    if (planLocks.get(planFileId) === tail) planLocks.delete(planFileId)
  }
}

export async function runPlanTvc(input: PlanTvcInput, deps: PlanTvcDeps): Promise<PlanTvcOutput> {
  if (input.action === 'check' && !input.planFileId) return runPlanTvcUnlocked(input, deps)
  if (!input.planFileId) return { refused: true, refusalReason: 'PLAN_FILE_ID_REQUIRED' }
  return withPlanLock(input.planFileId, () => runPlanTvcUnlocked(input, deps))
}

async function runPlanTvcUnlocked(input: PlanTvcInput, deps: PlanTvcDeps): Promise<PlanTvcOutput> {
  if (input.action === 'check') {
    if (!input.plan) return { refused: true, refusalReason: 'PLAN_REQUIRED' }
    const { errors, warnings, plan } = validateTvcPlan(input.plan)
    if (errors.length) return { errors, warnings }
    let storageKey = deps.newKey()
    let toSave = plan
    if (input.planFileId) {
      const previous = await deps.load(input.planFileId)
      storageKey = previous.storageKey
      toSave = carryOver(previous.plan, plan)
    }
    const planFileId = await deps.save({ version: 1, storageKey, plan: toSave })
    if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
    const cost = await deps.price(toSave)
    return { planFileId, errors: [], warnings, costCredits: cost.fullCostCredits, shortfallCredits: cost.shortfallCredits }
  }
  if (!input.planFileId) return { refused: true, refusalReason: 'PLAN_FILE_ID_REQUIRED' }
  const doc = await deps.load(input.planFileId)
  if (input.action === 'get') {
    try {
      return { planFileId: input.planFileId, slice: JSON.stringify(sliceTvcPlan(doc.plan, input.slice ?? '')) }
    } catch {
      return { refused: true, refusalReason: 'UNKNOWN_SLICE' }
    }
  }
  const records = [...(input.records ?? [])]
  if (input.shot !== undefined) records.push({ shot: input.shot, stillFileId: input.stillFileId, clipFileId: input.clipFileId, keptByUser: input.keptByUser })
  else if (input.stillFileId || input.clipFileId) return { refused: true, refusalReason: 'SHOT_AND_FILE_REQUIRED' }
  if (records.some((r) => !r.stillFileId && !r.clipFileId)) return { refused: true, refusalReason: 'SHOT_AND_FILE_REQUIRED' }
  const jingleFields = [input.jingleFileId, input.signoffFileId, input.signoffSeconds].filter((v) => v !== undefined).length
  if (jingleFields > 0 && jingleFields < 3) return { refused: true, refusalReason: 'JINGLE_RECORD_INCOMPLETE: record jingleFileId, signoffFileId and signoffSeconds together' }
  if (records.length === 0 && !input.narrationFileIds && !input.songFileId && jingleFields === 0) return { refused: true, refusalReason: 'NOTHING_TO_RECORD' }
  if (input.narrationFileIds && input.narrationFileIds.length !== doc.plan.voiceover.length) return { refused: true, refusalReason: 'NARRATION_COUNT_MISMATCH' }
  if (jingleFields === 3) {
    if (!doc.plan.brief.jingle) return { refused: true, refusalReason: 'NO_JINGLE_IN_PLAN: this plan has no brief.jingle; add one with a plan check first' }
    const errs = jingleErrors(doc.plan, input.signoffSeconds!)
    if (errs.length) return { refused: true, refusalReason: errs.join(' ') }
  }
  for (const r of records) {
    if (!r.stillFileId) continue
    const shot = doc.plan.shots.find((s) => s.n === r.shot)
    if (!shot) return { refused: true, refusalReason: 'NO_SUCH_SHOT' }
    if (shot.continuesFrom !== undefined) return { refused: true, refusalReason: `CONTINUING_SHOT_HAS_NO_STILL: shot ${r.shot} starts from shot ${shot.continuesFrom}'s last frame; record its clip only` }
    if (!r.keptByUser && !deps.stillChecked(r.stillFileId)) return { refused: true, refusalReason: `STILL_NOT_CHECKED: run check_still on shot ${r.shot}'s still first (or record it with keptByUser when the user chose to keep it)` }
  }
  let next: TvcPlan = doc.plan
  try {
    for (const r of records) next = recordOnPlan(next, r.shot, { stillFileId: r.stillFileId, clipFileId: r.clipFileId })
  } catch {
    return { refused: true, refusalReason: 'NO_SUCH_SHOT' }
  }
  if (input.narrationFileIds) next = { ...next, narrationFileIds: input.narrationFileIds }
  if (input.songFileId) next = { ...next, songFileId: input.songFileId }
  if (jingleFields === 3) next = { ...next, jingleFileId: input.jingleFileId, signoffFileId: input.signoffFileId, signoffSeconds: input.signoffSeconds }
  const planFileId = await deps.save({ ...doc, plan: next })
  if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
  return { planFileId }
}

export const planTvc = createTool({
  id: 'plan-tvc',
  description: 'Free. The TVC ad plan: "check" validates the plan against the TVC craft rules and saves it (returns the plan id and cost, or plain errors to fix); "get" returns only the slice one step needs; "record" attaches finished stills or clips to their shots (all of a step\'s files in one call, with records) and the finish narration and song to the plan. The finish can also record the sung sign-off (jingleFileId, signoffFileId, signoffSeconds); record refuses one that overlaps speech or is too long. Use only in the TVC ad flow.',
  inputSchema: planTvcInputSchema,
  outputSchema: z.object({
    planFileId: z.string().optional(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    costCredits: z.number().optional(),
    shortfallCredits: z.number().optional(),
    slice: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!idToken || !conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }
    const deps: PlanTvcDeps = {
      load: async (planFileId) => {
        const url = new URL(await fetchPresignedUrl(planFileId, idToken))
        url.searchParams.delete('x-amz-checksum-mode')
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`plan ${planFileId}: ${res.status}`)
        return await res.json() as SavedPlan
      },
      save: async (doc) => (await uploadFileWithKey(idToken, {
        key: doc.storageKey, name: 'TVC plan.json', content: JSON.stringify(doc), contentType: 'application/json',
      }))?.fileId ?? null,
      price: async (plan) => {
        const result = await computeCreditPlan(tvcCreditSteps(plan), { priceMicro: priceFromRates, readBalance: () => readBalanceForTenant(tenantId) })
        return { fullCostCredits: result.fullCostCredits, shortfallCredits: result.shortfallCredits }
      },
      newKey: () => `generated/${conversationId}/tvc-plan-${randomUUID()}.json`,
      stillChecked: (id) => stillPassedCheck(conversationId, id),
    }
    try {
      return await runPlanTvc(inputData as PlanTvcInput, deps)
    } catch (err) {
      console.error('[planTvc] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'PLAN_UNAVAILABLE' }
    }
  },
})
