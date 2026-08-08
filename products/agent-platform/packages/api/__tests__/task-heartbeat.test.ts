import { describe, it, expect, beforeEach } from 'vitest'
import {
  refreshTaskHeartbeat,
  startTaskHeartbeat,
  clearTaskHeartbeat,
  taskHeartbeatKey,
  TASK_HEARTBEAT_TTL_SECONDS,
} from '../lib/task-heartbeat'

/**
 * F-10 — the task watchdog heartbeat must be revivable.
 *
 * The bug: the heartbeat was created with SET ... EX 600 but refreshed with
 * EXPIRE. Redis EXPIRE is a no-op on a key that no longer exists — it returns 0
 * and creates nothing. So once more than 600s passed between two step callbacks
 * (one long agentic step is enough) the key was gone for good, every later
 * refresh silently did nothing, and the watchdog marked a task that was still
 * actively running as "blocked — the agent may have crashed", with no recovery.
 *
 * These tests run against a fake cache implementing real Redis semantics rather
 * than asserting which method was called, so they describe the behaviour that
 * matters: after a refresh, the heartbeat exists.
 */

/** Minimal Redis-accurate fake: EXPIRE only affects keys that already exist. */
function fakeCache() {
  const store = new Map<string, { value: string; ttl: number }>()
  return {
    store,
    async set(key: string, value: string, opts?: { ex?: number }) {
      store.set(key, { value, ttl: opts?.ex ?? -1 })
      return 'OK'
    },
    async expire(key: string, ttl: number) {
      const entry = store.get(key)
      if (!entry) return 0 // ← the crux: cannot resurrect a lapsed key
      entry.ttl = ttl
      return 1
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0
    },
  }
}

describe('task heartbeat', () => {
  let cache: ReturnType<typeof fakeCache>
  const TASK = 'task-123'

  beforeEach(() => {
    cache = fakeCache()
  })

  it('re-establishes the heartbeat after it has lapsed', async () => {
    // The exact production scenario: a step took longer than the TTL, so the key
    // expired while the agent was still working.
    expect(await cache.exists(taskHeartbeatKey(TASK))).toBe(0)

    await refreshTaskHeartbeat(cache as never, TASK)

    expect(await cache.exists(taskHeartbeatKey(TASK))).toBe(1)
  })

  it('keeps the heartbeat alive when it has not lapsed', async () => {
    await startTaskHeartbeat(cache as never, TASK, 'tenant-1')
    await refreshTaskHeartbeat(cache as never, TASK)

    expect(await cache.exists(taskHeartbeatKey(TASK))).toBe(1)
    expect(cache.store.get(taskHeartbeatKey(TASK))?.ttl).toBe(TASK_HEARTBEAT_TTL_SECONDS)
  })

  it('survives repeated lapse-and-refresh cycles', async () => {
    for (let i = 0; i < 3; i++) {
      cache.store.delete(taskHeartbeatKey(TASK)) // simulate TTL expiry
      await refreshTaskHeartbeat(cache as never, TASK)
      expect(await cache.exists(taskHeartbeatKey(TASK))).toBe(1)
    }
  })

  it('clears the heartbeat when the task finishes', async () => {
    await startTaskHeartbeat(cache as never, TASK, 'tenant-1')
    await clearTaskHeartbeat(cache as never, TASK)

    expect(await cache.exists(taskHeartbeatKey(TASK))).toBe(0)
  })

  it('does not throw when the cache is unavailable', async () => {
    const broken = {
      set: async () => { throw new Error('redis down') },
      expire: async () => { throw new Error('redis down') },
      del: async () => { throw new Error('redis down') },
    }
    // A heartbeat write must never fail the request that triggered it.
    await expect(refreshTaskHeartbeat(broken as never, TASK)).resolves.toBeUndefined()
    await expect(clearTaskHeartbeat(broken as never, TASK)).resolves.toBeUndefined()
  })
})
