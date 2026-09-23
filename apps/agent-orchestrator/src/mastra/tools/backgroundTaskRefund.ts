import type { BackgroundTask } from '@mastra/core/background-tasks'
import { refundVideoCharge } from './videoCredits.js'
import { refundImageCharge } from './imageCredits.js'

// Backstop for the rare case where the background-task manager itself
// fails a task (its own timeoutMs exceeded, or an uncaught throw inside
// execute() that never reached that function's own try/catch) — NOT the
// primary refund path. execute()'s existing inline refund-on-catch logic
// (unchanged; it runs as the background task body verbatim) still handles
// every ordinary generation failure exactly as it does synchronously
// today. This only fires when that logic never got the chance to run.
//
// task.resourceId is this codebase's tenantId and task.threadId is its
// conversationId — chatStream.ts's stream() call sets
// `memory: { thread: conversationId || crypto.randomUUID(), resource: tenantId }`,
// and Mastra threads both straight onto the BackgroundTask record (confirmed
// against @mastra/core's BackgroundTask type, not assumed). generateVideo.ts's
// real chargeKey is `video:${jobId}:${attempt}` = `video:${conversationId}:${toolCallId}:0`
// (attempt hardcoded 0 today) — generateImage.ts (post-Task-1) matches that
// exact 3-segment shape. This must stay byte-for-byte identical to what
// execute() actually charged under, or the refund's ledger lookup by
// chargeKey silently finds nothing and no-ops.
//
// rateId/rateVersion are not recoverable here (they were resolved from the
// live rate at charge time, inside execute(), and nothing on BackgroundTask
// carries them) — passed as null. This does not affect refund correctness:
// refundVideoCharge/refundImageCharge compute the refunded amount by
// reading the original debit back from credit_ledger by chargeKey, not
// from rateId/rateVersion — those two are only bookkeeping metadata on the
// refund's own ledger row. actorId is left undefined for the same reason
// (the custom per-request agentId lives in execContext.requestContext, not
// on BackgroundTask, which has its own unrelated `agentId` — the Mastra
// Agent's id, e.g. 'director') — spendCredits already treats undefined
// actorId as a real SQL NULL, so this is safe, just less attributable than
// the primary refund path.
export async function refundStaleBackgroundTask(task: BackgroundTask, kind: 'video' | 'image'): Promise<void> {
  const tenantId = task.resourceId
  if (!tenantId) {
    console.error(`[media-jobs] refundStaleBackgroundTask: task ${task.id} (${task.toolName}) has no resourceId — cannot refund`)
    return
  }
  const chargeKey = `${kind}:${task.threadId}:${task.toolCallId}:0`
  if (kind === 'video') {
    await refundVideoCharge(tenantId, undefined, chargeKey, null, null)
  } else {
    await refundImageCharge(tenantId, undefined, chargeKey, null, null)
  }
}
