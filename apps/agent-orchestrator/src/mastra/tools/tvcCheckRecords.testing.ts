import type { StoredThread, ThreadMetaStore } from './tvcCheckRecords.js'

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v

/** An in-memory thread store for tests. Like @mastra/pg it merges top-level
 *  metadata on update; like a jsonb column it does not keep key order (it
 *  sorts keys), so a test fails if code reads "oldest" from key order. */
export function inMemoryThreadStore(threads: StoredThread[] = []) {
  const rows = new Map(threads.map((t) => [t.id, structuredClone({ ...t, metadata: t.metadata ?? {} })]))
  const updates: Array<{ id: string; metadata: Record<string, unknown> }> = []
  const store: ThreadMetaStore = {
    async getThreadById({ threadId }) {
      await new Promise((r) => setTimeout(r, 1))
      const t = rows.get(threadId)
      return t ? structuredClone(t) : null
    },
    async updateThread({ id, metadata }) {
      await new Promise((r) => setTimeout(r, 1))
      const t = rows.get(id)
      if (!t) throw new Error(`Thread ${id} not found`)
      updates.push({ id, metadata: structuredClone(metadata) })
      t.metadata = sortKeys({ ...t.metadata, ...metadata }) as Record<string, unknown>
      return structuredClone(t)
    },
  }
  return { store, rows, updates }
}
