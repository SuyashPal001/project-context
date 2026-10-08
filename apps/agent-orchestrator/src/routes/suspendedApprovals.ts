// An approval card outlives the page that showed it (2026-10-09). The run
// waiting on it is persisted by Mastra (its workflow snapshot), so a click on
// the card after a reload, a dropped connection or an orchestrator restart can
// still answer it: the run is found again with listSuspendedRuns, scoped to
// the chat (threadId) and the tenant (resourceId), and resumed in a new turn.
// Before this, a dropped connection declined the run, and the user's later
// "yes" in the chat found nothing to approve.

export interface ResumeApproval {
  toolCallId: string
  decision: 'approved' | 'declined'
  declineReason?: string
  /** The messages row holding the card, so its status can be set. */
  cardMessageId?: string
}

export interface SuspendedApproval {
  runId: string
  toolCallId: string
  toolName?: string
  args?: unknown
}

interface SuspendedRunsAgent {
  listSuspendedRuns: (opts: { threadId: string; resourceId: string }) => Promise<{ runs?: Array<{ runId: string; toolCalls?: Array<{ toolCallId?: string; toolName?: string; args?: unknown; requiresApproval?: boolean }> }> }>
}

interface DecliningAgent extends SuspendedRunsAgent {
  declineToolCall: (opts: { runId: string; toolCallId: string; reason: string }) => Promise<{ consumeStream?: (opts?: { onError?: (err: unknown) => void }) => Promise<unknown> }>
}

const MAX_REASON_LEN = 500

/** The body's `resumeApproval`, or null when it is missing or malformed. */
export function parseResumeApproval(raw: unknown): ResumeApproval | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const toolCallId = typeof r.confirmationId === 'string' ? r.confirmationId.trim() : ''
  if (!toolCallId) return null
  if (r.decision !== 'approved' && r.decision !== 'declined') return null
  if (typeof r.reason === 'string' && r.reason.length > MAX_REASON_LEN) return null
  const declineReason = r.decision === 'declined' && typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined
  const cardMessageId = typeof r.cardMessageId === 'string' && r.cardMessageId.trim() ? r.cardMessageId.trim() : undefined
  return { toolCallId, decision: r.decision, ...(declineReason ? { declineReason } : {}), ...(cardMessageId ? { cardMessageId } : {}) }
}

/** The run still waiting on this card in this chat, or null when it is gone (answered, expired, or never existed). */
export async function findSuspendedApproval(agent: SuspendedRunsAgent, threadId: string, resourceId: string, toolCallId: string): Promise<SuspendedApproval | null> {
  try {
    const { runs = [] } = await agent.listSuspendedRuns({ threadId, resourceId })
    for (const run of runs) {
      const call = (run.toolCalls ?? []).find(tc => tc.requiresApproval && tc.toolCallId === toolCallId)
      if (call) return { runId: run.runId, toolCallId, ...(call.toolName ? { toolName: call.toolName } : {}), ...(call.args !== undefined ? { args: call.args } : {}) }
    }
  } catch (err) {
    console.error(`[resume-approval] listSuspendedRuns failed thread=${threadId}:`, (err as Error).message)
  }
  return null
}

/**
 * The user wrote a new message instead of answering a card left from an
 * earlier visit: that run is declined first, so two runs never write to one
 * chat. A card a live page still holds is left alone. Never throws.
 */
export async function declineStaleApprovals(agent: DecliningAgent, threadId: string, resourceId: string, isLive: (toolCallId: string) => boolean, reason: string): Promise<number> {
  let runs: Awaited<ReturnType<SuspendedRunsAgent['listSuspendedRuns']>>['runs'] = []
  try {
    runs = (await agent.listSuspendedRuns({ threadId, resourceId })).runs ?? []
  } catch (err) {
    console.error(`[stale-approval] listSuspendedRuns failed thread=${threadId}:`, (err as Error).message)
    return 0
  }
  let declined = 0
  for (const run of runs ?? []) {
    for (const call of run.toolCalls ?? []) {
      if (!call.requiresApproval || !call.toolCallId || isLive(call.toolCallId)) continue
      try {
        const stream = await agent.declineToolCall({ runId: run.runId, toolCallId: call.toolCallId, reason })
        // The decline only lands in the thread's history once its turn is drained.
        await stream?.consumeStream?.({ onError: (err) => console.error(`[stale-approval] resumed stream error runId=${run.runId}:`, (err as Error)?.message) })
        declined++
        console.log(`[stale-approval] declined runId=${run.runId} toolCallId=${call.toolCallId.slice(-10)} tool=${call.toolName ?? ''}`)
      } catch (err) {
        console.error(`[stale-approval] decline failed runId=${run.runId}:`, (err as Error).message)
      }
    }
  }
  return declined
}
