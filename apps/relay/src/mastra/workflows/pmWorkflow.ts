import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import pg from 'pg'
import { createPlanFromPrd } from '../../services/planService.js'
import type { PrdData } from '../../services/planService.js'

// ─── Shared DB pool ───────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[pmWorkflow] pool error:', err.message))
  }
  return _pool
}

async function fetchPrdById(prdId: string, tenantId: string) {
  const client = await getPool().connect()
  try {
    const { rows } = await client.query<{ content: string; title: string }>(
      `SELECT content, title FROM agent_prds WHERE id = $1 AND tenant_id = $2`,
      [prdId, tenantId],
    )
    return rows[0] ?? null
  } finally { client.release() }
}

async function fetchPlanData(planId: string, tenantId: string) {
  const client = await getPool().connect()
  try {
    const [{ rows: [plan] }, { rows: milestones }] = await Promise.all([
      client.query(`SELECT id, title, description FROM project_plans WHERE id = $1 AND tenant_id = $2`, [planId, tenantId]),
      client.query(`SELECT id, title, description, priority FROM project_milestones WHERE plan_id = $1 AND tenant_id = $2 ORDER BY sequence_id`, [planId, tenantId]),
    ])
    return plan ? { ...plan, milestones } : null
  } finally { client.release() }
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
  } finally { client.release() }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const workflowInputSchema = z.object({ prdId: z.string() })

// ─── Step 1: prdApprovalGate ─────────────────────────────────────────────────
// Immediately suspends — PRD was already generated+saved by chatStream.ts.
// Resumes when user clicks "Approve PRD" in Canvas.

export const prdApprovalGate = createStep({
  id: 'prd-approval-gate',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ prdId: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('prd'), prdId: z.string() }),
  execute: async ({ inputData, suspend }) => {
    const resumeData = await suspend({ phase: 'prd', prdId: inputData.prdId }, { timeout: 7 * 24 * 60 * 60 * 1000 })
    if (!resumeData?.approved) throw new Error('PRD approval declined')
    return { prdId: inputData.prdId }
  },
})

// ─── Step 2: roadmapGenStep ───────────────────────────────────────────────────
// Generates roadmap from the approved PRD, saves plan+milestones to DB,
// then suspends for user roadmap approval.

export const roadmapGenStep = createStep({
  id: 'roadmap-gen-step',
  inputSchema: z.object({ prdId: z.string() }),
  outputSchema: z.object({ planId: z.string(), title: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('roadmap'), planId: z.string(), title: z.string() }),
  execute: async ({ inputData, suspend, mastra, requestContext }) => {
    const tenantId = requestContext?.get('tenantId') as string
    const userId   = requestContext?.get('userId')   as string

    const prd = await fetchPrdById(inputData.prdId, tenantId)
    if (!prd) throw new Error(`PRD ${inputData.prdId} not found for tenant ${tenantId}`)

    // Run roadmapWorkflow (analyze → plan → format)
    const wf  = mastra.getWorkflow('roadmap')
    const run = wf.createRun()
    const res = await run.start({ inputData: { prdContent: prd.content }, requestContext })
    if (res.status !== 'success') throw new Error(`roadmapWorkflow failed: ${res.status}`)

    const prdData = (res as any).result?.prdData as PrdData
    const planResult = await createPlanFromPrd(tenantId, userId, prdData)

    const resumeData = await suspend({ phase: 'roadmap', planId: planResult.planId, title: prdData.plan.title }, { timeout: 7 * 24 * 60 * 60 * 1000 })
    if (!resumeData?.approved) throw new Error('Roadmap approval declined')

    return { planId: planResult.planId, title: prdData.plan.title }
  },
})

// ─── Step 3: tasksGenStep ─────────────────────────────────────────────────────
// Generates tasks for each milestone, saves to DB, then suspends for confirmation.

export const tasksGenStep = createStep({
  id: 'tasks-gen-step',
  inputSchema: z.object({ planId: z.string(), title: z.string() }),
  outputSchema: z.object({ planId: z.string(), taskCount: z.number() }),
  resumeSchema: z.object({ confirmed: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('tasks'), planId: z.string(), taskCount: z.number() }),
  execute: async ({ inputData, suspend, mastra, requestContext }) => {
    const tenantId = requestContext?.get('tenantId') as string
    const userId   = requestContext?.get('userId')   as string
    const agentId  = requestContext?.get('agentId')  as string ?? ''

    const planData = await fetchPlanData(inputData.planId, tenantId)
    if (!planData) throw new Error(`Plan ${inputData.planId} not found`)

    // Run taskWorkflow (analyze → generate → format)
    const wf  = mastra.getWorkflow('tasks')
    const run = wf.createRun()
    const res = await run.start({ inputData: { planData: JSON.stringify(planData) }, requestContext })
    if (res.status !== 'success') throw new Error(`taskWorkflow failed: ${res.status}`)

    const taskData = (res as any).result?.taskData
    const taskCount = await persistTaskData(tenantId, userId, agentId, taskData)

    const resumeData = await suspend({ phase: 'tasks', planId: inputData.planId, taskCount }, { timeout: 7 * 24 * 60 * 60 * 1000 })
    if (!resumeData?.confirmed) throw new Error('Tasks confirmation declined')

    return { planId: inputData.planId, taskCount }
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
  .then(prdApprovalGate)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(roadmapGenStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(tasksGenStep as any)
  .commit()
