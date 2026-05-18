import { createStep, createWorkflow } from '@mastra/core/workflows'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'

import { formatterAgent } from '../agents/formatterAgent.js'

// Load skill content once at module init — injected into generateText prompts
// so workflow steps get the same context roadmapAgent.generate() used to provide
// via its workspace. process.cwd() = relay root (PM2 exec cwd).
const roadmapSkill = readFileSync(
  resolve(process.cwd(), 'skills/roadmap-planning/SKILL.md'),
  'utf-8',
)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const workflowInputSchema = z.object({
  prdContent: z.string(),
})

const analyzeOutputSchema = z.object({
  analysis: z.string(),
})

const planOutputSchema = z.object({
  roadmapDraft: z.string(),
})

// PrdData shape — tasks must always be [] (Phase 3 fills them)
const milestoneSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  targetDate: z.string().optional(),
  tasks: z.array(z.any()).default([]),
})

const prdDataSchema = z.object({
  plan: z.object({
    title: z.string(),
    description: z.string(),
    targetDate: z.string().optional(),
  }),
  milestones: z.array(milestoneSchema),
  risks: z.array(z.string()),
  totalEstimatedHours: z.number().optional(),
})

const formatOutputSchema = z.object({
  prdData: prdDataSchema,
})

// ─── Step 1: analyzeStep ─────────────────────────────────────────────────────
// roadmapAgent extracts plan title, target date, feature areas, goals, risks
// from the approved PRD content. Plain text output only.

export const analyzeStep = createStep({
  id: 'analyze-prd',
  inputSchema: workflowInputSchema,
  outputSchema: analyzeOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const { prdContent } = inputData

    const prompt = [
      `Use the roadmap-planning skill to analyze this approved PRD.`,
      ``,
      `Extract and summarize in structured plain text:`,
      `- Product/feature name (will become the plan title)`,
      `- Overall target date or timeline mentioned`,
      `- Feature areas or functional requirements (will become milestones)`,
      `- Goals and success metrics (will become milestone acceptance criteria)`,
      `- Risks mentioned`,
      ``,
      `Risks: Even if no explicit risks are mentioned in the PRD, always infer`,
      `and list at least 2-3 implied risks based on the feature area.`,
      `For example: technical complexity risks, dependency risks,`,
      `security risks, timeline risks, integration risks.`,
      ``,
      `Write in structured plain text. Do not produce JSON.`,
      ``,
      `--- PRD ---`,
      prdContent,
      `--- End PRD ---`,
    ].join('\n')

    let analysis = ''

    try {
      const result = await formatterAgent.generate(`${roadmapSkill}\n\n${prompt}`, { requestContext })
      analysis = result.text ?? ''
      console.log(`[analyzeStep] analysis length=${analysis.length}`)
    } catch (err) {
      console.error('[analyzeStep] error:', (err as Error).message)
      analysis = prdContent
    }

    return { analysis }
  },
})

// ─── Step 2: planStep ─────────────────────────────────────────────────────────
// roadmapAgent generates 3–7 milestones from the analysis, following the
// roadmap-planning SKILL.md SOP. Plain text output for formatStep to parse.

export const planStep = createStep({
  id: 'plan-milestones',
  inputSchema: analyzeOutputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData, getInitData, requestContext }) => {
    const { analysis } = inputData
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()

    const prompt = [
      `Use the roadmap-planning skill to generate a roadmap from this PRD analysis.`,
      ``,
      `Original PRD (for reference):`,
      initData.prdContent.slice(0, 3000),
      ``,
      `Analysis:`,
      analysis,
      ``,
      `Generate 3–7 milestones. For each milestone write:`,
      `- title: short, outcome-focused`,
      `- description: 1–2 sentences on what this milestone delivers`,
      `- priority: low | medium | high | urgent`,
      `- acceptance_criteria: 2–4 plain-english done-criteria`,
      ``,
      `Order milestones chronologically. Do not generate tasks.`,
      ``,
      `Target dates: If no timeline is specified in the PRD, assume the project`,
      `starts today and assign realistic target dates to each milestone based on`,
      `its complexity and priority. Space milestones 2-4 weeks apart.`,
      `Format dates as YYYY-MM-DD.`,
      ``,
      `Write in structured plain text. Do not produce JSON.`,
    ].filter(Boolean).join('\n')

    let roadmapDraft = ''

    try {
      const result = await formatterAgent.generate(`${roadmapSkill}\n\n${prompt}`, { requestContext })
      roadmapDraft = result.text ?? ''
      console.log(`[planStep] roadmapDraft length=${roadmapDraft.length}`)
    } catch (err) {
      console.error('[planStep] error:', (err as Error).message)
      roadmapDraft = analysis
    }

    return { roadmapDraft }
  },
})

// ─── Step 3: formatStep ───────────────────────────────────────────────────────
// formatterAgent converts the plain-text roadmap draft into PrdData JSON.
// Two-pass pattern: formatterAgent has no tools so structuredOutput works
// without conflicting with functionDeclarations (Gemini constraint).
// tasks: [] on every milestone — Phase 3 (taskAgent) fills these.

export const formatStep = createStep({
  id: 'format-roadmap',
  inputSchema: planOutputSchema,
  outputSchema: formatOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const { roadmapDraft } = inputData

    const prompt = [
      `Convert the roadmap draft below into a structured JSON object matching the schema exactly.`,
      `tasks must be [] on every milestone — do not invent tasks.`,
      ``,
      `--- Roadmap Draft ---`,
      roadmapDraft.slice(0, 6000),
      `--- End Draft ---`,
      ``,
      `Return:`,
      `{ "prdData": {`,
      `    "plan": { "title": "...", "description": "...", "targetDate": "ISO string or omit" },`,
      `    "milestones": [{ "title": "...", "description": "...", "priority": "low|medium|high|urgent", "targetDate": "YYYY-MM-DD", "tasks": [] }],`,
      `    "risks": ["..."],`,
      `    "totalEstimatedHours": number or omit`,
      `  }`,
      `}`,
    ].join('\n')

    const fallback: z.infer<typeof formatOutputSchema> = {
      prdData: {
        plan: { title: 'Untitled Plan', description: roadmapDraft.slice(0, 200) },
        milestones: [],
        risks: [],
      },
    }

    try {
      const result = await formatterAgent.generate(prompt, {
        requestContext,
        structuredOutput: { schema: formatOutputSchema },
      })
      if (result.object) {
        console.log('[formatStep] structured roadmap produced successfully')
        return result.object as z.infer<typeof formatOutputSchema>
      }
    } catch (err) {
      console.error('[formatStep] error:', (err as Error).message)
    }

    return fallback
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const roadmapWorkflow = createWorkflow({
  id: 'roadmap-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: formatOutputSchema,
})
  .then(analyzeStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(planStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(formatStep as any)
  .commit()
