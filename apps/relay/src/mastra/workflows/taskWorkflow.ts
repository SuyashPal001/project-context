import { createStep, createWorkflow } from '@mastra/core/workflows'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'

import { formatterAgent } from '../agents/formatterAgent.js'
import { saveTasks } from '../tools/saveTasks.js'

// Load skill content once at module init — injected into generateText prompts
// so workflow steps get the same context taskAgent.generate() used to provide
// via its workspace. process.cwd() = relay root (PM2 exec cwd).
const taskSkill = readFileSync(
  resolve(process.cwd(), 'skills/task-breakdown/SKILL.md'),
  'utf-8',
)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const workflowInputSchema = z.object({
  planData: z.string(), // JSON string: plan + milestones from fetchPlan
})

const analyzeOutputSchema = z.object({
  analysis: z.string(),
})

const generateOutputSchema = z.object({
  taskDraft: z.string(),
})

// TaskGenerationData shape — acceptance_criteria stored as string[] here;
// saveTasks.ts converts each entry to { text, checked: false } before INSERT.
const taskItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  estimatedHours: z.number().optional(),
})

const milestoneTaskDataSchema = z.object({
  milestoneId: z.string(),   // FK → project_milestones.id — must come from input, never invented
  milestoneName: z.string(), // logging only
  tasks: z.array(taskItemSchema),
})

const taskGenerationDataSchema = z.object({
  planId: z.string(),
  milestones: z.array(milestoneTaskDataSchema),
})

const formatOutputSchema = z.object({
  taskData: taskGenerationDataSchema,
})

const saveOutputSchema = z.object({
  planId: z.string(),
  taskCount: z.number(),
})

// ─── Step 1: analyzeStep ─────────────────────────────────────────────────────

export const analyzeStep = createStep({
  id: 'analyze-milestones',
  inputSchema: workflowInputSchema,
  outputSchema: analyzeOutputSchema,
  execute: async ({ inputData }) => {
    const { planData } = inputData

    const prompt = [
      `Use the task-breakdown skill to analyze this project plan.`,
      ``,
      `For each milestone, summarize in structured plain text:`,
      `- Milestone title and ID (preserve the exact ID)`,
      `- Scope: what work is in scope for this milestone`,
      `- Priority: the milestone priority and what it implies for tasks`,
      `- Acceptance criteria: what done looks like`,
      `- Complexity estimate: simple | moderate | complex`,
      ``,
      `Do not generate tasks yet. Write in structured plain text. Do not produce JSON.`,
      ``,
      `--- Plan Data ---`,
      planData,
      `--- End Plan Data ---`,
    ].join('\n')

    let analysis = ''

    try {
      const result = await formatterAgent.generate(`${taskSkill}\n\n${prompt}`)
      analysis = result.text ?? ''
      console.log(`[analyzeStep:tasks] analysis length=${analysis.length}`)
    } catch (err) {
      console.error('[analyzeStep:tasks] error:', (err as Error).message)
      analysis = planData
    }

    return { analysis }
  },
})

// ─── Step 2: generateStep ─────────────────────────────────────────────────────

export const generateStep = createStep({
  id: 'generate-tasks',
  inputSchema: analyzeOutputSchema,
  outputSchema: generateOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const { analysis } = inputData
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()

    // Always surface all milestone IDs even if the full JSON is large.
    // Truncating planData risks cutting UUIDs — the LLM would invent them,
    // causing FK violations or orphaned rows in saveTasks.
    let milestoneRef = initData.planData.slice(0, 20000)
    try {
      const parsed = JSON.parse(initData.planData)
      const idLines = (parsed?.milestones ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((m: any) => `${m.id} — ${m.title}`)
        .join('\n')
      if (idLines) {
        milestoneRef = `Plan data excerpt:\n${initData.planData.slice(0, 20000)}\n\nAll milestone IDs (never invent these):\n${idLines}`
      }
    } catch { /* use raw slice */ }

    const prompt = [
      `Use the task-breakdown skill to generate tasks for each milestone.`,
      ``,
      `Original plan data (milestone IDs must be copied exactly — do not invent IDs):`,
      milestoneRef,
      ``,
      `Milestone analysis:`,
      analysis,
      ``,
      `For each milestone generate 3–7 tasks. For each task write:`,
      `- milestoneId: the exact UUID from the plan data above`,
      `- title: action-oriented verb phrase`,
      `- description: 1–2 sentences on what to build and why`,
      `- priority: low | medium | high | urgent`,
      `- acceptanceCriteria: 2–4 plain-english done-criteria as a list`,
      `- estimatedHours: integer 1–8`,
      ``,
      `Order tasks within each milestone: foundational first, polish last.`,
      `Write in structured plain text. Do not produce JSON.`,
    ].filter(Boolean).join('\n')

    let taskDraft = ''

    try {
      const result = await formatterAgent.generate(`${taskSkill}\n\n${prompt}`)
      taskDraft = result.text ?? ''
      console.log(`[generateStep:tasks] taskDraft length=${taskDraft.length}`)
    } catch (err) {
      console.error('[generateStep:tasks] error:', (err as Error).message)
      taskDraft = analysis
    }

    return { taskDraft }
  },
})

// ─── Step 3: formatStep ───────────────────────────────────────────────────────
// formatterAgent converts the plain-text task draft into TaskGenerationData JSON.
// Two-pass pattern: formatterAgent has no tools so structuredOutput works
// without conflicting with functionDeclarations (Gemini constraint).
// milestoneId values must be real UUIDs copied from planData — never invented.
// acceptanceCriteria remains string[] here; saveTasks converts to {text,checked}[].

export const formatStep = createStep({
  id: 'format-tasks',
  inputSchema: generateOutputSchema,
  outputSchema: formatOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const { taskDraft } = inputData
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()

    // Parse real IDs from planData — never trust LLM to copy UUIDs correctly
    let planId = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let realMilestones: Array<{ id: string; title: string }> = []
    try {
      const parsed = JSON.parse(initData.planData)
      planId = parsed?.plan?.id ?? parsed?.id ?? ''
      realMilestones = (parsed?.milestones ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((m: any) => ({ id: m.id as string, title: m.title as string }))
        .filter((m: { id: string }) => !!m.id)
    } catch {
      // planId stays empty, realMilestones stays []
    }

    const prompt = [
      `Convert the task draft below into a structured JSON object matching the schema exactly.`,
      `milestoneId on every milestone must be a real UUID from the plan — never invent IDs.`,
      `acceptanceCriteria must be an array of plain strings (not objects).`,
      `estimatedHours must always be a positive integer, minimum 1, never 0 or null.`,
      planId ? `planId must be: "${planId}"` : `Extract planId from the task draft or plan data.`,
      ``,
      `--- Task Draft ---`,
      taskDraft.slice(0, 8000),
      `--- End Draft ---`,
      ``,
      `Return:`,
      `{ "taskData": {`,
      `    "planId": "uuid",`,
      `    "milestones": [{`,
      `      "milestoneId": "uuid",`,
      `      "milestoneName": "...",`,
      `      "tasks": [{`,
      `        "title": "...",`,
      `        "description": "...",`,
      `        "acceptanceCriteria": ["...", "..."],`,
      `        "priority": "low|medium|high|urgent",`,
      `        "estimatedHours": number`,
      `      }]`,
      `    }]`,
      `  }`,
      `}`,
    ].join('\n')

    const fallback: z.infer<typeof formatOutputSchema> = {
      taskData: { planId, milestones: [] },
    }

    try {
      const result = await formatterAgent.generate(prompt, {
        structuredOutput: { schema: formatOutputSchema },
      })
      if (result.object) {
        const output = result.object as z.infer<typeof formatOutputSchema>

        // Post-process: overwrite planId and milestoneIds from real data
        output.taskData.planId = planId || output.taskData.planId

        // Match LLM milestones to real milestones by order (LLM preserves order)
        // then overwrite milestoneId with the real UUID
        for (let i = 0; i < output.taskData.milestones.length; i++) {
          const llmMilestone = output.taskData.milestones[i]
          if (i < realMilestones.length) {
            llmMilestone.milestoneId = realMilestones[i].id
            llmMilestone.milestoneName = llmMilestone.milestoneName || realMilestones[i].title
          }
          // Clamp estimatedHours: minimum 1, never 0/null/undefined
          for (const task of llmMilestone.tasks) {
            task.estimatedHours = Math.max(1, task.estimatedHours ?? 1)
          }
        }

        console.log('[formatStep:tasks] structured task data produced successfully')
        return output
      }
    } catch (err) {
      console.error('[formatStep:tasks] error:', (err as Error).message)
    }

    return fallback
  },
})

// ─── Step 4: saveStep ─────────────────────────────────────────────────────────
// Persists all tasks to agent_tasks via saveTasks tool.
// Returns planId + taskCount so the owning agent can report back to pmAgent.

export const saveStep = createStep({
  id: 'save-tasks',
  inputSchema: formatOutputSchema,
  outputSchema: saveOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const { taskData } = inputData
    try {
      const result = await saveTasks.execute!(
        { taskData },
        { requestContext },
      )
      console.log(`[saveStep:tasks] saved tasksCreated=${result.tasksCreated} planId=${taskData.planId}`)
      return { planId: taskData.planId, taskCount: result.tasksCreated }
    } catch (err) {
      console.error('[saveStep:tasks] error:', (err as Error).message)
      throw err
    }
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const taskWorkflow = createWorkflow({
  id: 'task-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: saveOutputSchema,
})
  .then(analyzeStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(generateStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(formatStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(saveStep as any)
  .commit()
