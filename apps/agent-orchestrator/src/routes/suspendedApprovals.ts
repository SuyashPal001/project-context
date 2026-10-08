// An approval card outlives the page that showed it (2026-10-09). The run
// waiting on it is persisted by Mastra (its workflow snapshot), so a click on
// the card after a reload, a dropped connection or an orchestrator restart can
// still answer it: the run is found again with listSuspendedRuns, scoped to
// the chat (threadId) and the tenant (resourceId), and resumed in a new turn.
// Before this, a dropped connection declined the run, and the user's later
// "yes" in the chat found nothing to approve.
//
// A card left open is not declined when the user writes something else: the
// web hides the composer while a card is pending, and the watchdog's 24h sweep
// declines whatever is never answered (internal.ts).

import { sql } from 'drizzle-orm'
import { executeSql } from '../mastra/tools/folderScope.js'

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

/** found: resume it. missing: answered, expired or never kept. error: storage failed, the run may still be there. */
export type SuspendedApprovalLookup =
  | { status: 'found'; approval: SuspendedApproval }
  | { status: 'missing' }
  | { status: 'error' }

interface SuspendedRunsAgent {
  listSuspendedRuns: (opts: { threadId: string; resourceId: string }) => Promise<{ runs?: Array<{ runId: string; toolCalls?: Array<{ toolCallId?: string; toolName?: string; args?: unknown; requiresApproval?: boolean }> }> }>
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

/** The run still waiting on this card in this chat. */
export async function findSuspendedApproval(agent: SuspendedRunsAgent, threadId: string, resourceId: string, toolCallId: string): Promise<SuspendedApprovalLookup> {
  try {
    const { runs = [] } = await agent.listSuspendedRuns({ threadId, resourceId })
    for (const run of runs) {
      const call = (run.toolCalls ?? []).find(tc => tc.requiresApproval && tc.toolCallId === toolCallId)
      if (call) return { status: 'found', approval: { runId: run.runId, toolCallId, ...(call.toolName ? { toolName: call.toolName } : {}), ...(call.args !== undefined ? { args: call.args } : {}) } }
    }
    return { status: 'missing' }
  } catch (err) {
    console.error(`[resume-approval] listSuspendedRuns failed thread=${threadId}:`, (err as Error).message)
    return { status: 'error' }
  }
}

// Cards being resumed right now, so a second click, a second tab or a retried
// request cannot run the same generation twice.
export const resumingToolCalls = new Set<string>()

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown }
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>
}

/**
 * The prompt Olmo last gave a delegate in this chat. A resumed turn starts
 * with a new request context, so the flags onDelegationStart read off that
 * prompt (the reviewed ad flow, a TVC's reference video) are read again from
 * it (hooks.ts applyDelegationPromptFlags). Delegate threads are named
 * `<conversationId>-<uuid>` and owned by `<tenantId>-<delegate>`.
 */
export async function latestDelegationPrompt(conversationId: string, tenantId: string): Promise<string | null> {
  if (!conversationId || !tenantId) return null
  try {
    const result = await executeSql(sql`
      SELECT content FROM mastra.mastra_messages
      WHERE thread_id LIKE ${conversationId + '-%'} AND "resourceId" LIKE ${tenantId + '-%'} AND role = 'user'
      ORDER BY "createdAt" DESC
      LIMIT 1
    `)
    const raw = rowsOf(result)[0]?.content
    const content = typeof raw === 'string' ? JSON.parse(raw) : raw
    const parts = (content as { parts?: Array<{ type?: string; text?: string }> } | undefined)?.parts ?? []
    const text = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
    return text || null
  } catch (err) {
    console.error(`[resume-approval] delegation prompt lookup failed conversation=${conversationId}:`, (err as Error).message)
    return null
  }
}
