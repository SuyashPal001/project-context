import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { confirmGenerationOrDecline } from './confirmGeneration.js'
import { filterPII } from '../../pii-filter.js'

const MAX_BODY_BYTES = 65_536
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface CreateSkillResult {
  success: boolean
  message?: string
  error?: string
  /** False means the agent must not call this tool again for this request. */
  retryable?: boolean
  skillId?: string
}

/**
 * Validates the frontmatter contract `parseSkillManifest` enforces in the
 * import worker. Checked here so a malformed draft is a tool error the agent
 * can fix on the spot, rather than a `failed` version row the user discovers
 * minutes later on the Skills page.
 */
// Best-effort mirror of parseSkillManifest, not a full re-implementation: the
// worker module isn't importable from here (see task brief), so this checks
// the delimiter and the two required keys by regex rather than by running a
// real YAML.parse. A body with a `name:`/`description:` line present but
// broken YAML elsewhere in the frontmatter (bad indentation, an unterminated
// quote, etc.) passes this check and still fails at import time in the
// worker, which does parse it for real and requires non-empty trimmed
// strings for both fields.
function validateSkillBody(body: string): string | null {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return `SKILL.md must be under ${MAX_BODY_BYTES} bytes`
  const match = FRONTMATTER_RE.exec(body)
  if (!match) return 'SKILL.md must start with a --- YAML frontmatter block'
  const frontmatter = match[1]
  if (!/^name:\s*\S/m.test(frontmatter)) return "SKILL.md frontmatter is missing required field 'name'"
  if (!/^description:\s*\S/m.test(frontmatter)) return "SKILL.md frontmatter is missing required field 'description'"
  return null
}

// Exported separately (rather than inlined into createTool's config) so a
// test can assert on its shape directly: this is the security boundary the
// API route's permission check depends on. tenantId/userId/agentId/
// conversationId must never appear here — they come only from
// execContext.requestContext (the authenticated session), never from
// anything the model can name.
export const createSkillInputSchema = z.object({
  name: z.string().min(1).max(100).describe('Human-readable skill name, e.g. "Bid Writer"'),
  description: z.string().max(2000).optional().describe('One line on what the skill is for'),
  body: z.string().min(1).describe('The complete SKILL.md, frontmatter included'),
})

export const createSkillTool = createTool({
  id: 'create_skill',
  description: `Save a reusable skill for this workspace from what you have learned in this conversation.

Call this ONLY when the user explicitly asks for it — "save that as a skill", "/create-skill", "remember this as a skill". Never call it on your own initiative.

You write the file. \`body\` must be a complete SKILL.md:
- Start with a YAML frontmatter block delimited by --- lines, containing name (lowercase kebab-case) and description (one sentence saying when an agent should use this skill).
- After the closing ---, write instructions addressed to the agent that will follow them: when the skill applies, concrete steps, exact phrasings and formats, and what to avoid.
- Never invent facts about the user's business. Where a specific is unknown, tell the agent to ask.

The user is shown the draft and must approve it. The skill applies from their next message, not this reply.`,
  inputSchema: createSkillInputSchema,
  execute: async (inputData, execContext) => {
    const { name, description, body } = inputData as { name: string; description?: string; body: string }

    const invalid = validateSkillBody(body)
    if (invalid) return { success: false, error: invalid, retryable: true }

    const ctx = execContext?.requestContext
    const tenantId = ctx?.get('tenantId') as string | undefined
    const userId = ctx?.get('userId') as string | undefined
    const agentId = ctx?.get('agentId') as string | undefined
    const conversationId = ctx?.get('conversationId') as string | undefined
    const sendEvent = ctx?.get('sendEvent')
    const sessionId = ctx?.get('sessionId') as string | undefined

    // No live session means the confirm gate would auto-approve — see its
    // sendEvent/sessionId guard. For a spend gate that is a documented hole;
    // for a write into the tenant's skill library it would mean unattended
    // creation. Must cover every identifier confirmGenerationOrDecline's own
    // guard checks (sendEvent, sessionId, tenantId, userId), not a subset —
    // a caller that sets sendEvent without sessionId would otherwise slip
    // past this guard and still get auto-approved by the gate underneath.
    if (!sendEvent || !sessionId || !tenantId || !userId || !agentId || !conversationId) {
      return {
        success: false,
        error: 'Skills can only be created from a live chat session.',
        retryable: false,
      }
    }

    // filterPII covers India identity patterns (email, phone, Aadhaar, PAN,
    // passport, voter id) and nothing credential-shaped. It informs the human
    // rather than blocking — the confirmation card is the actual control.
    const pii = filterPII(body)
    const piiNote = pii.detections.length > 0
      ? ` — personal data detected: ${[...new Set(pii.detections.map((d) => d.type))].join(', ')}`
      : ''

    const confirmation = await confirmGenerationOrDecline(
      execContext,
      'skill_creation',
      'create',
      `Create skill "${name}"${piiNote}`,
      { alwaysAsk: true },
    )
    if (!confirmation.confirmed) {
      return {
        success: false,
        error: confirmation.reason === 'CONFIRM_BUSY'
          ? 'Another confirmation is already open — finish that one first.'
          : 'The user declined, so nothing was created.',
        retryable: false,
      }
    }

    const messageId = sessionId ?? conversationId

    try {
      const res = await fetch(`${process.env.API_BASE_URL}/api/v1/internal/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ tenantId, userId, agentId, conversationId, messageId, name, description, body }),
      })

      if (!res.ok) {
        const code = (await res.json().catch(() => ({}))).code as string | undefined
        const error =
          code === 'QUOTA_EXCEEDED' ? "This workspace has reached today's limit for creating skills."
          : code === 'INSUFFICIENT_PERMISSIONS' ? 'Your role does not allow creating skills.'
          : code === 'DUPLICATE_REQUEST' ? 'That skill was already created.'
          : 'The skill could not be saved.'
        return { success: false, error, retryable: false }
      }

      const { data } = await res.json() as { data: { skillId: string } }
      return {
        success: true,
        skillId: data.skillId,
        // Skills load once at stream start, so this reply cannot use it.
        message: `Saved "${name}" as a skill and attached it to this agent. It takes effect from your next message.`,
      }
    } catch (err) {
      console.error('[create_skill] failed:', (err as Error).message)
      return { success: false, error: 'The skill could not be saved.', retryable: false }
    }
  },
})
