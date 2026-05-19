import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import pg from 'pg'
import { fetchPRD } from '../tools/fetchPRD.js'
import { fetchPlan } from '../tools/fetchPlan.js'

// ─── Shared DB pool (plan activation only) ───────────────────────────────────

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[pmWorkflow] pool error:', err.message))
  }
  return _pool
}

async function activatePlan(planId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query(`UPDATE project_plans SET status = 'active', updated_at = NOW() WHERE id = $1`, [planId])
  } finally {
    client.release()
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const workflowInputSchema = z.object({
  userPrompt: z.union([z.string(), z.record(z.any())]),
})

// ─── Step 1: prdStep ─────────────────────────────────────────────────────────
// Invokes prdWorkflow (gather → write → format → save), then suspends for
// user approval/revision. On approval, fetches PRD content for roadmapStep.

export const prdStep = createStep({
  id: 'prd-step',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ prdId: z.string(), prdContent: z.string() }),
  resumeSchema: z.object({ approved: z.boolean().optional(), revise: z.string().optional() }),
  suspendSchema: z.object({ phase: z.literal('prd'), prdId: z.string(), title: z.string() }),
  execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
    const runPrdWorkflow = async (userMessage: string) => {
      const run = mastra!.getWorkflow('prd-workflow').createRun()
      const result = await (run as any).execute({ inputData: { userMessage, conversationHistory: '' }, requestContext })
      return (result?.result ?? result) as { prdId: string; prdContent: string }
    }

    // First run — generate PRD from user prompt
    if (!suspendData?.prdId) {
      const userMessage = typeof inputData.userPrompt === 'string'
        ? inputData.userPrompt
        : ((inputData.userPrompt as any).content?.find((p: any) => p.type === 'text')?.text ?? '')
      const { prdId, prdContent } = await runPrdWorkflow(userMessage)
      const title = prdContent.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 100) || 'PRD'
      console.log(`[prdStep] PRD generated: ${prdId}`)
      return await suspend({ phase: 'prd', prdId, title })
    }

    // Resume with revision — re-run prdWorkflow with new instructions
    if (resumeData?.revise) {
      const { prdId, prdContent } = await runPrdWorkflow(resumeData.revise)
      const title = prdContent.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 100) || 'PRD'
      console.log(`[prdStep] PRD revised: ${prdId}`)
      return await suspend({ phase: 'prd', prdId, title })
    }

    if (!resumeData?.approved) throw new Error('PRD approval declined')

    // Approved — fetch content (draft status allowed) to pass to roadmapStep
    const { prd } = await fetchPRD.execute!({ prdId: suspendData.prdId, allowDraft: true }, { requestContext })
    if (!prd) throw new Error(`PRD ${suspendData.prdId} not found after approval`)
    return { prdId: prd.id, prdContent: prd.content }
  },
})

// ─── Step 2: roadmapStep ─────────────────────────────────────────────────────
// Invokes roadmapWorkflow (analyze → plan → format → save), activates the plan
// in DB, then suspends for approval.

export const roadmapStep = createStep({
  id: 'roadmap-step',
  inputSchema: z.object({ prdId: z.string(), prdContent: z.string() }),
  outputSchema: z.object({ planId: z.string(), title: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ phase: z.literal('roadmap'), planId: z.string(), title: z.string() }),
  execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
    if (!suspendData?.planId) {
      const run = mastra!.getWorkflow('roadmap-workflow').createRun()
      const result = await (run as any).execute({ inputData: { prdContent: inputData.prdContent }, requestContext })
      const { planId, title } = (result?.result ?? result) as { planId: string; title: string }

      // Activate plan so fetchPlan can retrieve it in taskStep
      await activatePlan(planId)
      console.log(`[roadmapStep] Roadmap saved + activated: ${planId}`)

      return await suspend({ phase: 'roadmap', planId, title })
    }

    if (!resumeData?.approved) throw new Error('Roadmap approval declined')
    return { planId: suspendData.planId, title: suspendData.title }
  },
})

// ─── Step 3: taskStep ────────────────────────────────────────────────────────
// Fetches the activated plan (with milestone IDs), invokes taskWorkflow
// (analyze → generate → format → save). No HITL — tasks are final output.

export const taskStep = createStep({
  id: 'task-step',
  inputSchema: z.object({ planId: z.string(), title: z.string() }),
  outputSchema: z.object({ planId: z.string(), taskCount: z.number() }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const { plan, reason } = await fetchPlan.execute!({ planId: inputData.planId }, { requestContext })
    if (!plan) throw new Error(`Cannot fetch plan for tasks: ${reason}`)

    const run = mastra!.getWorkflow('task-workflow').createRun()
    const result = await (run as any).execute({
      inputData: { planData: JSON.stringify(plan) },
      requestContext,
    })
    const { planId, taskCount } = (result?.result ?? result) as { planId: string; taskCount: number }
    console.log(`[taskStep] ${taskCount} tasks generated for planId=${planId}`)
    return { planId, taskCount }
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────
// Triggered by schedule or automation. Chains prdWorkflow → roadmapWorkflow →
// taskWorkflow with HITL approval gates between phases (via notifications + UI).

export const pmWorkflow = createWorkflow({
  id: 'pm-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ planId: z.string(), taskCount: z.number() }),
})
  .then(prdStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(roadmapStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(taskStep as any)
  .commit()
