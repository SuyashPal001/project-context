/**
 * Task watchdog heartbeat.
 *
 * The watchdog treats an `in_progress` task with no heartbeat key as stalled and
 * marks it blocked. Keeping that decision correct depends on one property: a
 * refresh must be able to RE-CREATE the key, not merely extend it.
 *
 * Redis `EXPIRE` returns 0 and creates nothing when the key is absent, so
 * refreshing with EXPIRE is not self-healing — once the TTL lapses (a single
 * agentic step running longer than the window is enough) the heartbeat can never
 * come back, and the watchdog kills a task that is still running and still
 * reporting progress. Every write here therefore uses SET with a TTL.
 *
 * All operations swallow cache errors: a heartbeat write must never fail the
 * request that triggered it. The cost of a missed write is one spurious stall
 * detection; the cost of a thrown error is a failed step callback.
 */

export const TASK_HEARTBEAT_TTL_SECONDS = 600;

export function taskHeartbeatKey(taskId: string): string {
  return `task:watchdog:${taskId}`;
}

interface HeartbeatCache {
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Begin tracking a task. Called when execution starts. */
export async function startTaskHeartbeat(
  cache: HeartbeatCache,
  taskId: string,
  tenantId: string,
): Promise<void> {
  await write(cache, taskId, tenantId);
}

/**
 * Extend the heartbeat, re-creating it if it has already lapsed.
 * Called on every step transition while the agent is working.
 */
export async function refreshTaskHeartbeat(
  cache: HeartbeatCache,
  taskId: string,
  tenantId?: string,
): Promise<void> {
  await write(cache, taskId, tenantId);
}

/** Stop tracking a task. Called when it reaches a terminal state. */
export async function clearTaskHeartbeat(
  cache: HeartbeatCache,
  taskId: string,
): Promise<void> {
  try {
    await cache.del(taskHeartbeatKey(taskId));
  } catch {
    /* non-fatal — see module comment */
  }
}

async function write(cache: HeartbeatCache, taskId: string, tenantId?: string): Promise<void> {
  try {
    await cache.set(
      taskHeartbeatKey(taskId),
      JSON.stringify({ taskId, tenantId: tenantId ?? null, beatAt: Date.now() }),
      { ex: TASK_HEARTBEAT_TTL_SECONDS },
    );
  } catch {
    /* non-fatal — see module comment */
  }
}
