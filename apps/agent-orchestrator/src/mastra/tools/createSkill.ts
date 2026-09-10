import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { API_BASE_URL } from '../../types.js'

const MAX_BODY_BYTES = 65_536

// Mirrors MAX_COMPOSED_SKILL_CHARS in ../../usage.ts (itself mirrored by the
// API's attach route and the import worker). Duplicated rather than imported:
// usage.ts opens a pg pool and pulls in the database/ai packages at module
// load, which this tool has no other reason to touch. If that number changes,
// change it in all four places.
const MAX_COMPOSED_SKILL_CHARS = 24_000

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

// Mirrors MIN_DESCRIPTION_LENGTH in
// products/agent-platform/packages/worker-handlers/lib/skillManifest.ts — see
// that file's comment for the reasoning. Kept in sync by hand, not imported:
// same cross-package boundary as MAX_COMPOSED_SKILL_CHARS above.
const MIN_DESCRIPTION_LENGTH = 20

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
// the delimiter, the two required keys, and the description length floor by
// regex rather than by running a real YAML.parse. A body with a
// `name:`/`description:` line present but broken YAML elsewhere in the
// frontmatter (bad indentation, an unterminated quote, etc.) passes this
// check and still fails at import time in the worker, which does parse it
// for real and requires non-empty trimmed strings for both fields (plus the
// same MIN_DESCRIPTION_LENGTH floor on description).
function validateSkillBody(body: string, name: string): string | null {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return `SKILL.md must be under ${MAX_BODY_BYTES} bytes`
  // The composition budget, checked here rather than discovered later. A body
  // over this never attaches: the import worker's budget check drops the attach
  // with a log only, after this tool has already told the user the skill will
  // attach. Rejecting up front makes it a retryable error the agent can fix by
  // writing something shorter. The cost formula mirrors fetchAgentSkills' —
  // body plus the "## Skill: <name>\n\n" header it is wrapped in.
  if (body.length + name.length + 15 > MAX_COMPOSED_SKILL_CHARS) {
    return `SKILL.md is too long to attach — the body must be under ${MAX_COMPOSED_SKILL_CHARS - name.length - 15} characters. Write a shorter, tighter skill.`
  }
  const match = FRONTMATTER_RE.exec(body)
  if (!match) return 'SKILL.md must start with a --- YAML frontmatter block'
  const frontmatter = match[1]
  if (!/^name:\s*\S/m.test(frontmatter)) return "SKILL.md frontmatter is missing required field 'name'"
  const descriptionMatch = /^description:\s*(\S.*)$/m.exec(frontmatter)
  if (!descriptionMatch) return "SKILL.md frontmatter is missing required field 'description'"
  const description = descriptionMatch[1].trim()
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return `SKILL.md frontmatter 'description' is too short to be useful (${description.length} chars, minimum ${MIN_DESCRIPTION_LENGTH}) — write a real sentence saying when an agent should use this skill`
  }
  // Weak but cheap proxy for "states when to use it" vs. "summarizes what it
  // does" — the two read differently to a human, but the only mechanical
  // signal available without an LLM pass is whether the sentence bothers to
  // say "when" at all. Mirrors the same floor in skillManifest.ts.
  if (!/\bwhen\b/i.test(description)) {
    return `SKILL.md frontmatter 'description' should say when to use this skill, not just what it does — start with "Use when..." and name the trigger`
  }
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
- Start with a YAML frontmatter block delimited by --- lines, containing name (lowercase kebab-case) and description (one sentence saying when an agent should use this skill, at least 20 characters).
- After the closing ---, write instructions addressed to the agent that will follow them: when the skill applies, concrete steps, exact phrasings and formats, and what to avoid.

The user is shown the draft and must approve it. The skill applies from their next message, not this reply.`,
  inputSchema: createSkillInputSchema,
  // Unconditional gate, mirroring today's alwaysAsk: true — this tool never
  // checks isUnlimited/resolveRate (creating a skill is free; a human still
  // must see it). The only reason to skip the pause is an invalid draft,
  // where there is nothing meaningful to show on a card and execute() will
  // reject it immediately anyway (validateSkillBody runs there unchanged).
  requireApproval: async (input) => {
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

    // DELETE the old confirmGenerationOrDecline call and its CONFIRM_BUSY
    // branch entirely — approval already happened (or was skipped because
    // the draft was invalid, in which case execute() already returned
    // above) before this line runs. The card's preview/PII note are now
    // built once, in chatStream.ts, from GENERATION_APPROVAL_METADATA's
    // create_skill.buildPreview — not recomputed here.

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

      const { data } = await res.json() as { data: { skillId: string } }
      return {
        success: true,
        skillId: data.skillId,
        // Skills load once at stream start, so this reply cannot use it.
        message: `Saved "${name}" as a skill. It will attach to this agent once processing finishes, and takes effect from your next message.`,
      }
    } catch (err) {
      console.error('[create_skill] failed:', (err as Error).message)
      return { success: false, error: 'The skill could not be saved.', retryable: true }
    }
  },
})
