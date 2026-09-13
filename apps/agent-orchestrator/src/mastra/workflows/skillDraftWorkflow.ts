import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

import { skillDraftAgent } from '../agents/skillDraftAgent.js'
import { validateSkillBody, validateVerbatimTokens } from '../lib/skillValidation.js'

// A failed draft costs one small skillDraftAgent call, not a full
// platformAgent turn — but still bounded, so a persistently-invalid draft
// (e.g. the model repeatedly ignoring the line cap) fails fast instead of
// looping indefinitely.
const MAX_DRAFT_ATTEMPTS = 4

// dountil() re-feeds a step's own output back in as its next input, so
// input and output schemas must match exactly — this single shape carries
// both "what to draft" (name, brief) and "where the loop is" (draft, error,
// valid) through every iteration.
const draftStateSchema = z.object({
  name: z.string(),
  brief: z.string(),
  draft: z.string().default(''),
  error: z.string().optional(),
  valid: z.boolean().default(false),
})

const draftAndValidateStep = createStep({
  id: 'draft-and-validate-skill',
  inputSchema: draftStateSchema,
  outputSchema: draftStateSchema,
  execute: async ({ inputData }) => {
    const { name, brief, draft, error } = inputData

    const prompt = error
      ? [
          `Your previous SKILL.md draft failed validation: ${error}`,
          ``,
          `Previous draft:`,
          draft,
          ``,
          `Rewrite the COMPLETE corrected SKILL.md — fix only what the error names, keep everything else.`,
        ].join('\n')
      : [
          `Skill name: ${name}`,
          ``,
          `Brief (what it should teach the agent):`,
          brief,
          ``,
          `Write the complete SKILL.md.`,
        ].join('\n')

    let newDraft = ''
    try {
      const result = await skillDraftAgent.generate(prompt)
      newDraft = (result.text ?? '').trim()
    } catch (err) {
      return { name, brief, draft, error: `Draft generation failed: ${(err as Error).message}`, valid: false }
    }

    // Format checks first (cheap, regex-only); verbatim-token diffing only
    // runs once the draft is already well-formed, since there's no point
    // diffing IDs inside a draft that's about to fail for missing
    // frontmatter anyway.
    const validationError = validateSkillBody(newDraft, name) ?? validateVerbatimTokens(brief, newDraft)
    return { name, brief, draft: newDraft, error: validationError ?? undefined, valid: !validationError }
  },
})

export const skillDraftWorkflow = createWorkflow({
  id: 'skill-draft-workflow',
  inputSchema: draftStateSchema,
  outputSchema: draftStateSchema,
})
  // dountil always runs the step at least once before checking the
  // condition, so no separate seed .then() is needed.
  .dountil(
    draftAndValidateStep,
    async ({ inputData: { valid }, iterationCount }) => valid === true || iterationCount >= MAX_DRAFT_ATTEMPTS,
  )
  .commit()
