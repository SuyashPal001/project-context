import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import pg from 'pg'
import { createPlanFromPrd } from '../../services/planService.js'
import type { PrdData } from '../../services/planService.js'
import { formatterAgent } from '../agents/formatterAgent.js'

// ─── Shared DB pool ───────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[pmWorkflow] pool error:', err.message))
  }
  return _pool
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function savePrdToDb(tenantId: string, userId: string, agentId: string, content: string, title: string): Promise<string> {
  const client = await getPool().connect()
  try {
    const prdId = randomUUID()
    await client.query(
      `INSERT INTO agent_prds (id, tenant_id, agent_id, created_by, title, content, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', NOW(), NOW())`,
      [prdId, tenantId, agentId, userId, title, content],
    )
    return prdId
  } finally {
    client.release()
  }
}

async function fetchPrdById(prdId: string, tenantId: string) {
  const client = await getPool().connect()
  try {
    const { rows } = await client.query<{ content: string; title: string }>(
      `SELECT content, title FROM agent_prds WHERE id = $1 AND tenant_id = $2`,
      [prdId, tenantId],
    )
    return rows[0] ?? null
  } finally {
    client.release()
  }
}

async function updatePrdInDb(prdId: string, content: string, title: string, tenantId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query(
      `UPDATE agent_prds SET content = $1, title = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4`,
      [content, title, prdId, tenantId],
    )
  } finally {
    client.release()
  }
}

async function fetchPlanData(planId: string, tenantId: string) {
  const client = await getPool().connect()
  try {
    const [{ rows: [plan] }, { rows: milestones }] = await Promise.all([
      client.query(`SELECT id, title, description FROM project_plans WHERE id = $1 AND tenant_id = $2`, [planId, tenantId]),
      client.query(`SELECT id, title, description, priority FROM project_milestones WHERE plan_id = $1 AND tenant_id = $2 ORDER BY sequence_id`, [planId, tenantId]),
    ])
    return plan ? { plan, milestones } : null
  } finally {
    client.release()
  }
}

async function persistTaskData(tenantId: string, userId: string, agentId: string, taskData: any) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    let total = 0
    for (const ms of taskData.milestones ?? []) {
      if (!ms.tasks?.length) continue
      const vals: unknown[] = []
      const phs: string[] = []
      let p = 1
      for (const t of ms.tasks) {
        const ac = (t.acceptanceCriteria ?? []).map((s: string) => ({ text: s, checked: false }))
        phs.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,$${p++},$${p++},'backlog',$${p++},$${p++},NOW(),NOW())`)
        vals.push(randomUUID(), tenantId, userId, agentId, t.title, t.description ?? null,
          JSON.stringify(ac), t.priority ?? 'medium',
          t.estimatedHours != null ? String(t.estimatedHours) : null,
          taskData.planId, ms.milestoneId)
        total++
      }
      await client.query(
        `INSERT INTO agent_tasks (id,tenant_id,created_by,agent_id,title,description,acceptance_criteria,priority,estimated_hours,status,plan_id,milestone_id,created_at,updated_at) VALUES ${phs.join(',')}`,
        vals,
      )
    }
    await client.query('COMMIT')
    return total
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const workflowInputSchema = z.object({
  // Accepts plain text OR multipart message object (when user attaches files/images)
  userPrompt: z.union([z.string(), z.record(z.any())]),
})

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

const taskItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  estimatedHours: z.number().optional(),
})

const milestoneTaskDataSchema = z.object({
  milestoneId: z.string(),
  milestoneName: z.string(),
  tasks: z.array(taskItemSchema),
})

const taskGenerationDataSchema = z.object({
  planId: z.string(),
  milestones: z.array(milestoneTaskDataSchema),
})

// ─── Step 1: prdGenStep ───────────────────────────────────────────────────────
// Three-phase HITL step:
//   Phase A (first run)  : prdAgent generates clarifying questions → suspend('prd-clarify')
//   Phase B (resume A)   : prdAgent writes full PRD from prompt+answers → save → suspend('prd')
//   Phase C (resume B)   : user approved → fetch PRD and pass to roadmapGenStep

export const prdGenStep = createStep({
  id: 'prd-gen-step',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ prdId: z.string(), prdContent: z.string() }),
  resumeSchema: z.object({
    answers: z.string().optional(),
    revise: z.string().optional(),
    approved: z.boolean().optional(),
  }),
  suspendSchema: z.object({
    phase: z.enum(['prd-clarify', 'prd']),
    questions: z.string().optional(),
    originalPrompt: z.string().optional(),
    prdId: z.string().optional(),
    title: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
    const tenantId = requestContext?.get('tenantId') as string
    const userId = requestContext?.get('userId') as string
    const agentId = requestContext?.get('agentId') as string ?? ''

    // ── Phase A: generate clarifying questions (or load existing PRD) ────────
    if (!suspendData?.phase) {
      // Shortcut: pmAgent extracted an existingPrdId — skip clarification and generation
      const existingPrdId = requestContext?.get('existingPrdId') as string | undefined
      if (existingPrdId) {
        const prd = await fetchPrdById(existingPrdId, tenantId)
        if (!prd) throw new Error(`PRD ${existingPrdId} not found`)
        console.log(`[prdGenStep] existing PRD loaded: ${existingPrdId}`)
        return await suspend({ phase: 'prd', prdId: existingPrdId, title: prd.title })
      }

      const prdAgent = mastra.getAgent('prdAgent')

      // Extract text portion for the questions prompt (discard image data)
      const userPromptText = typeof inputData.userPrompt === 'string'
        ? inputData.userPrompt
        : ((inputData.userPrompt as any).content?.find((p: any) => p.type === 'text')?.text
            ?? JSON.stringify(inputData.userPrompt))

      const clarifyPrompt = [
        `Before writing a PRD, ask exactly 4 targeted clarifying questions.`,
        `Focus on what would change the document: who the user is, platform/scope, constraints, and success metrics.`,
        `Be specific to the request — no generic questions.`,
        ``,
        `Format:`,
        `1. [question]`,
        `2. [question]`,
        `3. [question]`,
        `4. [question]`,
        ``,
        `No preamble. No answers. Just the 4 numbered questions.`,
        ``,
        `User request: "${userPromptText}"`,
      ].join('\n')

      const result = await prdAgent.generate(clarifyPrompt, { requestContext })
      const questions = result.text || ''

      return await suspend({ phase: 'prd-clarify', questions, originalPrompt: userPromptText })
    }

    // ── Phase B: generate PRD from original prompt + user answers ─────────────
    if (suspendData.phase === 'prd-clarify') {
      const answers = resumeData?.answers ?? ''
      const originalPrompt = suspendData.originalPrompt ?? ''
      const prdAgent = mastra.getAgent('prdAgent')

      const generatePrompt = [
        `Write a complete Product Requirements Document (PRD).`,
        ``,
        `Original request:`,
        originalPrompt,
        ``,
        `User answers to clarifying questions:`,
        answers,
        ``,
        `Structure: # Title, ## Overview, ## Problem Statement, ## Goals,`,
        `## User Stories, ## Functional Requirements, ## Out of Scope, ## Success Metrics`,
      ].join('\n')

      const result = await prdAgent.generate(generatePrompt, { requestContext })
      const prdContent = result.text || ''
      const title = prdContent.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 100) || 'Product Requirements Document'
      const prdId = await savePrdToDb(tenantId, userId, agentId, prdContent, title)
      console.log(`[prdGenStep] PRD saved: ${prdId}`)

      return await suspend({ phase: 'prd', prdId, title })
    }

    // ── Phase C: revision or approval ────────────────────────────────────────
    if (resumeData?.revise) {
      const currentPrd = await fetchPrdById(suspendData.prdId!, tenantId)
      const prdAgent = mastra.getAgent('prdAgent')

      const revisePrompt = [
        `Revise the following PRD based on the revision instructions.`,
        `Return the complete revised document — same structure, updated content.`,
        ``,
        `Revision instructions: ${resumeData.revise}`,
        ``,
        `Current PRD:`,
        currentPrd?.content ?? '',
      ].join('\n')

      const result = await prdAgent.generate(revisePrompt, { requestContext })
      const prdContent = result.text || ''
      const title = prdContent.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 100) || suspendData.title || 'Product Requirements Document'
      await updatePrdInDb(suspendData.prdId!, prdContent, title, tenantId)
      console.log(`[prdGenStep] PRD revised: ${suspendData.prdId}`)

      return await suspend({ phase: 'prd', prdId: suspendData.prdId!, title })
    }

    if (!resumeData?.approved) {
      throw new Error('PRD approval declined')
    }

    const prd = await fetchPrdById(suspendData.prdId!, tenantId)
    if (!prd) throw new Error(`PRD ${suspendData.prdId} not found`)

    return { prdId: suspendData.prdId!, prdContent: prd.content }
  },
})

// ─── Step 2: roadmapGenStep ───────────────────────────────────────────────────
// roadmapAgent (analyze → plan) + formatterAgent (→ JSON) → save → suspend for approval.

export const roadmapGenStep = createStep({
  id: 'roadmap-gen-step',
  inputSchema: z.object({ prdId: z.string(), prdContent: z.string() }),
  outputSchema: z.object({ planId: z.string(), title: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('roadmap'), planId: z.string(), title: z.string() }),
  execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
    const tenantId = requestContext?.get('tenantId') as string
    const userId = requestContext?.get('userId') as string

    // On first execution, generate roadmap (or load existing plan)
    if (!suspendData?.planId) {
      // Shortcut: pmAgent extracted an existingPlanId — skip generation
      const existingPlanId = requestContext?.get('existingPlanId') as string | undefined
      if (existingPlanId) {
        const planData = await fetchPlanData(existingPlanId, tenantId)
        if (!planData) throw new Error(`Plan ${existingPlanId} not found`)
        console.log(`[roadmapGenStep] existing plan loaded: ${existingPlanId}`)
        return await suspend({ phase: 'roadmap', planId: existingPlanId, title: planData.plan.title })
      }

      const { prdContent } = inputData
      const roadmapAgent = mastra.getAgent('roadmap')

      // Analyze PRD
      const analyzePrompt = [
        `Analyze this approved PRD and extract in structured plain text:`,
        `- Product/feature name (will become the plan title)`,
        `- Overall target date or timeline mentioned`,
        `- Feature areas or functional requirements (will become milestones)`,
        `- Goals and success metrics (will become milestone acceptance criteria)`,
        `- Risks mentioned (infer at least 2-3 if not explicit)`,
        ``,
        `Do not produce JSON. Do not call any tools.`,
        ``,
        `--- PRD ---`,
        prdContent,
        `--- End PRD ---`,
      ].join('\n')

      const analysisResult = await roadmapAgent.generate(analyzePrompt, { requestContext })
      const analysis = analysisResult.text || ''

      // Generate milestones
      const planPrompt = [
        `Generate a roadmap from this PRD analysis.`,
        ``,
        `Original PRD:`,
        prdContent.slice(0, 3000),
        ``,
        `Analysis:`,
        analysis,
        ``,
        `Generate 3–7 milestones with: title, description, priority, target date.`,
        `Order chronologically. Space 2-4 weeks apart. Format dates as YYYY-MM-DD.`,
        `Write in structured plain text. Do not produce JSON. Do not call any tools.`,
      ].join('\n')

      const planResult = await roadmapAgent.generate(planPrompt, { requestContext })
      const roadmapDraft = planResult.text || ''

      // Format to structured data
      const formatPrompt = [
        `Convert the roadmap draft below into structured JSON.`,
        `tasks must be [] on every milestone.`,
        ``,
        `--- Roadmap Draft ---`,
        roadmapDraft.slice(0, 6000),
        `--- End Draft ---`,
        ``,
        `Return: { "prdData": { "plan": {...}, "milestones": [...], "risks": [...] } }`,
      ].join('\n')

      const formatResult = await formatterAgent.generate(formatPrompt, {
        structuredOutput: { schema: z.object({ prdData: prdDataSchema }) },
      })

      const prdData = (formatResult.object?.prdData || {
        plan: { title: 'Untitled Plan', description: roadmapDraft.slice(0, 200) },
        milestones: [],
        risks: [],
      }) as PrdData

      // Save to database
      const planResult2 = await createPlanFromPrd(tenantId, userId, prdData)
      console.log(`[roadmapGenStep] Plan saved: ${planResult2.planId}`)

      return await suspend({
        phase: 'roadmap',
        planId: planResult2.planId,
        title: prdData.plan.title
      })
    }

    // On resume, check approval
    if (!resumeData?.approved) {
      throw new Error('Roadmap approval declined')
    }

    return { planId: suspendData.planId, title: suspendData.title }
  },
})

// ─── Step 3: tasksGenStep ─────────────────────────────────────────────────────
// taskAgent (analyze → generate) + formatterAgent (→ JSON) → save → suspend for confirmation.

export const tasksGenStep = createStep({
  id: 'tasks-gen-step',
  inputSchema: z.object({ planId: z.string(), title: z.string() }),
  outputSchema: z.object({ planId: z.string(), taskCount: z.number() }),
  resumeSchema: z.object({ confirmed: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('tasks'), planId: z.string(), taskCount: z.number() }),
  execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
    const tenantId = requestContext?.get('tenantId') as string
    const userId = requestContext?.get('userId') as string
    const agentId = requestContext?.get('agentId') as string ?? ''

    // On first execution, generate tasks
    if (!suspendData?.taskCount) {
      const planData = await fetchPlanData(inputData.planId, tenantId)
      if (!planData) throw new Error(`Plan ${inputData.planId} not found`)

      const planDataStr = JSON.stringify(planData)
      const taskAgent = mastra.getAgent('task')

      // Analyze milestones
      const analyzePrompt = [
        `Analyze this project plan. For each milestone summarize: scope, priority, acceptance criteria, complexity.`,
        `Do not generate tasks yet. Write in structured plain text. Do not call any tools.`,
        ``,
        `--- Plan Data ---`,
        planDataStr,
        `--- End Plan Data ---`,
      ].join('\n')

      const analysisResult = await taskAgent.generate(analyzePrompt, { requestContext })
      const analysis = analysisResult.text || ''

      // Generate tasks
      const milestoneIds = planData.milestones.map((m: any) => `${m.id} — ${m.title}`).join('\n')
      const generatePrompt = [
        `Generate tasks for each milestone below.`,
        ``,
        `Milestone IDs (copy exactly, never invent):`,
        milestoneIds,
        ``,
        `Analysis:`,
        analysis,
        ``,
        `For each milestone generate 3–7 tasks with: title, description, priority, acceptanceCriteria, estimatedHours.`,
        `Write in structured plain text. Do not produce JSON. Do not call any tools.`,
      ].join('\n')

      const generateResult = await taskAgent.generate(generatePrompt, { requestContext })
      const taskDraft = generateResult.text || ''

      // Format to structured data
      const formatPrompt = [
        `Convert the task draft below into structured JSON.`,
        `milestoneId must be real UUIDs. acceptanceCriteria is string[]. estimatedHours >= 1.`,
        `planId: "${inputData.planId}"`,
        ``,
        `--- Task Draft ---`,
        taskDraft.slice(0, 8000),
        `--- End Draft ---`,
        ``,
        `Return: { "taskData": { "planId": "...", "milestones": [...] } }`,
      ].join('\n')

      const formatResult = await formatterAgent.generate(formatPrompt, {
        structuredOutput: { schema: z.object({ taskData: taskGenerationDataSchema }) },
      })

      let taskData = formatResult.object?.taskData || { planId: inputData.planId, milestones: [] }

      // Post-process: ensure correct IDs
      taskData.planId = inputData.planId
      for (let i = 0; i < taskData.milestones.length && i < planData.milestones.length; i++) {
        taskData.milestones[i].milestoneId = planData.milestones[i].id
        for (const task of taskData.milestones[i].tasks) {
          task.estimatedHours = Math.max(1, task.estimatedHours ?? 1)
        }
      }

      // Save to database
      const taskCount = await persistTaskData(tenantId, userId, agentId, taskData)
      console.log(`[tasksGenStep] ${taskCount} tasks saved`)

      return await suspend({ phase: 'tasks', planId: inputData.planId, taskCount })
    }

    // On resume, check confirmation
    if (!resumeData?.confirmed) {
      throw new Error('Tasks confirmation declined')
    }

    return { planId: suspendData.planId, taskCount: suspendData.taskCount }
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const pmWorkflow = createWorkflow({
  id: 'pm-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ planId: z.string(), taskCount: z.number() }),
  retryConfig: {
    attempts: 3,
    delay: 2000,
  },
  options: {
    onError: async (errorInfo) => {
      console.error(`[pmWorkflow] failed runId=${errorInfo.runId}:`, errorInfo.error?.message ?? errorInfo.error)
    },
  },
})
  .then(prdGenStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(roadmapGenStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(tasksGenStep as any)
  .commit()
