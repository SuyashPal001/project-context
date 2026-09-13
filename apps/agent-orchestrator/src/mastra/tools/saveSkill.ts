import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { API_BASE_URL } from '../../types.js'
import { validateSkillBody } from '../lib/skillValidation.js'

interface SaveSkillResult {
  success: boolean
  message?: string
  error?: string
  /** False means the agent must not call this tool again for this request. */
  retryable?: boolean
  skillId?: string
}

// Exported separately (rather than inlined into createTool's config) so a
// test can assert on its shape directly: this is the security boundary the
// API route's permission check depends on. tenantId/userId/agentId/
// conversationId must never appear here — they come only from
// execContext.requestContext (the authenticated session), never from
// anything the model can name.
export const saveSkillInputSchema = z.object({
  name: z.string().min(1).max(100).describe('Human-readable skill name, e.g. "Bid Writer" — the same name the user gave you, not the frontmatter kebab-case one.'),
  description: z.string().max(2000).optional().describe('One line on what the skill is for — copy this from the draft\'s own frontmatter description, do not write a new one.'),
  body: z.string().min(1).describe('The complete, already-validated SKILL.md from draft_skill\'s output — do not edit it unless the user asked for a change.'),
})

export const saveSkillTool = createTool({
  id: 'save_skill',
  description: `Persist a validated SKILL.md draft as a reusable skill for this workspace. Requires calling draft_skill first — never write a SKILL.md body yourself and pass it here.

Call this ONLY after the user has seen the draft_skill output and approved it, or asked for it to be saved — "save that as a skill", "/create-skill", "looks good, save it". Never call it on your own initiative, and never on an unreviewed draft.

The user is shown the draft again and must approve. The skill applies from their next message, not this reply.`,
  inputSchema: saveSkillInputSchema,
  // Unconditional gate, mirroring today's alwaysAsk: true — this tool never
  // checks isUnlimited/resolveRate (creating a skill is free; a human still
  // must see it). Two reasons to skip the pause:
  //   1. An invalid draft — nothing meaningful to show on a card, and
  //      execute() rejects it immediately anyway (validateSkillBody runs
  //      there unchanged). Shouldn't happen given draft_skill already
  //      validated it, but a user-edited body could reintroduce an issue.
  //   2. No live SSE session — same liveness check shouldRequireApproval
  //      makes, and the same one execute()'s hard guard below makes. Paths
  //      that never handle the `tool-call-approval` chunk (index.ts's
  //      WebSocket loop, mastra/agent.ts's background-task generate()) would
  //      otherwise suspend the run silently for 24h instead of letting
  //      execute() return its clean, immediate error. Note `ctx.requestContext`
  //      here is a plain object view, not a RequestContext instance — no .get().
  requireApproval: async (input, ctx) => {
    const sendEvent = ctx?.requestContext?.sendEvent
    if (!sendEvent) return false
    const { name, body } = input as { name: string; body: string }
    return !validateSkillBody(body, name)
  },
  execute: async (inputData, execContext) => {
    const { name, description, body } = inputData as { name: string; description?: string; body: string }

    const invalid = validateSkillBody(body, name)
    if (invalid) return { success: false, error: invalid, retryable: true }

    const ctx = execContext?.requestContext
    const tenantId = ctx?.get('tenantId') as string | undefined
    const userId = ctx?.get('userId') as string | undefined
    const agentId = ctx?.get('agentId') as string | undefined
    const conversationId = ctx?.get('conversationId') as string | undefined
    const sendEvent = ctx?.get('sendEvent')
    const sessionId = ctx?.get('sessionId') as string | undefined

    // Same hard guard as today — this tool requires a live chat session
    // regardless of the approval outcome; requireApproval above has no
    // opinion on session liveness (that check has no card to skip to).
    if (!sendEvent || !sessionId || !tenantId || !userId || !agentId || !conversationId) {
      return {
        success: false,
        error: 'Skills can only be created from a live chat session.',
        retryable: false,
      }
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/internal/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ tenantId, userId, agentId, conversationId, messageId: sessionId, name, description, body }),
      })

      if (!res.ok) {
        const code = (await res.json().catch(() => ({}))).code as string | undefined
        const error =
          code === 'QUOTA_EXCEEDED' ? "This workspace has reached today's limit for creating skills."
          : code === 'INSUFFICIENT_PERMISSIONS' ? 'Your role does not allow creating skills.'
          : code === 'DUPLICATE_REQUEST' ? 'That skill was already created.'
          : code === 'AGENT_NOT_FOUND' ? 'That agent is not part of this workspace.'
          : 'The skill could not be saved.'
        return { success: false, error, retryable: false }
      }

      const { data } = await res.json() as { data: { skillId: string; attached: boolean } }
      return {
        success: true,
        skillId: data.skillId,
        // Skills load once at stream start, so this reply cannot use it.
        // `attached` is false only for the built-in platform agent (Olmo) —
        // internal/skills.ts deliberately skips attaching there, since Olmo
        // is shared tenant-wide and never takes a permanent skill.
        message: data.attached
          ? `Saved "${name}" as a skill. It will attach to this agent once processing finishes, and takes effect from your next message.`
          : `Saved "${name}" as a skill. This agent doesn't take permanent skill attachments — turn it on anytime with "/${name}" in chat, or attach it permanently to a custom AI employee.`,
      }
    } catch (err) {
      console.error('[save_skill] failed:', (err as Error).message)
      return { success: false, error: 'The skill could not be saved.', retryable: true }
    }
  },
})
