import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { skillDraftWorkflow } from '../workflows/skillDraftWorkflow.js'

interface DraftSkillResult {
  success: boolean
  draft?: string
  error?: string
  /** False means the agent must not call this tool again for this request. */
  retryable?: boolean
}

export const draftSkillInputSchema = z.object({
  name: z.string().min(1).max(100).describe('The skill name the user gave you, e.g. "RFP Response Writing". Never invent this yourself — ask the user for it first.'),
  brief: z.string().min(1).describe('Everything the user told you this skill should teach an agent — the full brief, gathered via clarifying questions, not summarized.'),
})

export const draftSkillTool = createTool({
  id: 'draft_skill',
  description: `Draft a complete SKILL.md from a name and brief, and return it for the user to review. Does NOT save anything — call save_skill after the user approves.

Call this ONLY after you have both:
1. A skill name — ask the user for it if they haven't given one. Never invent a name yourself.
2. A brief — gather it via ask_clarifying_questions if the user hasn't already given you enough detail on what the skill should teach.

You write neither the description nor the body yourself — this tool drafts both from the brief and validates the result internally (retrying automatically on a fixable issue). Show the returned draft to the user before calling save_skill.`,
  inputSchema: draftSkillInputSchema,
  execute: async (inputData) => {
    const { name, brief } = inputData as { name: string; brief: string }

    try {
      const run = await skillDraftWorkflow.createRun()
      const result = await run.start({ inputData: { name, brief, draft: '', valid: false } })

      if (result.status !== 'success') {
        return { success: false, error: 'Drafting failed unexpectedly.', retryable: true } satisfies DraftSkillResult
      }
      if (!result.result.valid) {
        return {
          success: false,
          error: result.result.error ?? 'Could not produce a valid draft after several attempts.',
          retryable: true,
        } satisfies DraftSkillResult
      }

      return { success: true, draft: result.result.draft } satisfies DraftSkillResult
    } catch (err) {
      console.error('[draft_skill] failed:', (err as Error).message)
      return { success: false, error: 'The skill could not be drafted.', retryable: true } satisfies DraftSkillResult
    }
  },
})
