import { Hono } from 'hono'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { validateToken } from '../auth.js'
import { mastra } from '../mastra/index.js'
import { getAllowedOrigin } from '../types.js'
import { prdApprovalGate, roadmapGenStep, tasksGenStep } from '../mastra/workflows/pmWorkflow.js'

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function corsHeaders(origin: string | undefined) {
  const allowed = getAllowedOrigin(origin)
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Id-Token',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

// ─── Helper: extract suspended step id from workflow result ───────────────────

function getSuspendedStep(result: any): { stepId: string; suspendPayload: Record<string, unknown> } | null {
  for (const [stepId, step] of Object.entries(result.steps ?? {})) {
    const s = step as any
    if (s.status === 'suspended') {
      return { stepId, suspendPayload: s.suspendPayload ?? {} }
    }
  }
  return null
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const pmRouter = new Hono()

// CORS preflight
pmRouter.options('/pm/start',  (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header('Origin')) }))
pmRouter.options('/pm/resume', (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header('Origin')) }))

// POST /pm/start — called after PRD is saved; immediately suspends at prdApprovalGate
// Body: { prdId, conversationId, tenantId? }
// Returns: { runId, stepId: 'prd-approval-gate', phase: 'prd', prdId }
pmRouter.post('/pm/start', async (c) => {
  const origin = c.req.header('Origin')
  const hdrs = corsHeaders(origin)

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: any
  try { payload = await validateToken(token) } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const tenantId = (payload['custom:tenantId'] as string | undefined) ?? ''
  const userId   = (payload.sub as string) ?? ''
  const agentId  = c.req.header('X-Agent-Id') ?? ''

  const { prdId, conversationId } = await c.req.json() as { prdId: string; conversationId?: string }
  if (!prdId) return c.json({ error: 'prdId required' }, 400)

  const requestContext = new RequestContext()
  requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
  requestContext.set(MASTRA_THREAD_ID_KEY, conversationId ?? prdId)
  requestContext.set('tenantId', tenantId)
  requestContext.set('userId', userId)
  requestContext.set('agentId', agentId)

  try {
    const wf  = mastra.getWorkflow('pm-workflow')
    const run = wf.createRun()
    const result = await run.start({ inputData: { prdId }, requestContext })

    if (result.status !== 'suspended') {
      console.error('[pm/start] unexpected status:', result.status)
      return c.json({ error: 'Workflow did not suspend as expected' }, 500)
    }

    const suspended = getSuspendedStep(result)
    return c.json({
      runId: run.runId,
      stepId: suspended?.stepId ?? 'prd-approval-gate',
      phase: 'prd',
      prdId,
    }, 200, hdrs)
  } catch (err) {
    console.error('[pm/start] error:', (err as Error).message)
    return c.json({ error: 'Failed to start PM workflow' }, 500)
  }
})

// POST /pm/resume — resumes a suspended step; triggers next generation phase
// Body: { runId, stepId, approved?: boolean, confirmed?: boolean }
// Returns: { phase, runId?, stepId?, planId?, taskCount?, title? } | { phase: 'done' }
pmRouter.post('/pm/resume', async (c) => {
  const origin = c.req.header('Origin')
  const hdrs = corsHeaders(origin)

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: any
  try { payload = await validateToken(token) } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const tenantId = (payload['custom:tenantId'] as string | undefined) ?? ''
  const userId   = (payload.sub as string) ?? ''
  const agentId  = c.req.header('X-Agent-Id') ?? ''

  const { runId, stepId, approved = true, confirmed = true } = await c.req.json() as {
    runId: string; stepId: string; approved?: boolean; confirmed?: boolean
  }
  if (!runId || !stepId) return c.json({ error: 'runId and stepId required' }, 400)

  const requestContext = new RequestContext()
  requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
  requestContext.set('tenantId', tenantId)
  requestContext.set('userId', userId)
  requestContext.set('agentId', agentId)

  // Build resumeData based on which step we're resuming
  const resumeData = stepId === 'tasks-gen-step'
    ? { confirmed }
    : { approved }

  try {
    const wf  = mastra.getWorkflow('pm-workflow')
    const run = wf.createRun({ runId })
    const result = await run.resume({ resumeData, step: stepId, requestContext })

    // Workflow suspended at the next step
    if (result.status === 'suspended') {
      const suspended = getSuspendedStep(result)
      if (!suspended) return c.json({ error: 'Could not determine suspended step' }, 500)

      const sp = suspended.suspendPayload as any
      return c.json({
        phase: sp.phase,
        runId,
        stepId: suspended.stepId,
        planId: sp.planId,
        title: sp.title,
        taskCount: sp.taskCount,
      }, 200, hdrs)
    }

    // Workflow completed all phases
    if (result.status === 'success') {
      return c.json({ phase: 'done' }, 200, hdrs)
    }

    console.error('[pm/resume] unexpected status:', result.status)
    return c.json({ error: 'Workflow failed', status: result.status }, 500)
  } catch (err) {
    console.error('[pm/resume] error:', (err as Error).message)
    return c.json({ error: 'Failed to resume PM workflow' }, 500)
  }
})
