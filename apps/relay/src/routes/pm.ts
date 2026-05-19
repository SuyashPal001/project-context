import { Hono } from 'hono'
import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import { validateToken } from '../auth.js'
import { mastra } from '../mastra/index.js'
import { getAllowedOrigin } from '../types.js'

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

// ─── Helper: extract suspended step from workflow result ──────────────────────

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

pmRouter.options('/pm/resume', (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header('Origin')) }))

// POST /pm/resume
// Resumes a suspended pmWorkflow step and triggers the next generation phase.
// The workflow is always started from chatStream.ts when PM intent is detected.
//
// Body:
//   { runId, stepId, answers?: string, revise?: string, approved?: boolean, confirmed?: boolean }
//
// Step IDs + resume payloads:
//   prd-gen-step (phase prd-clarify) → { answers: string }    clarification answers
//   prd-gen-step (phase prd)         → { revise: string }     revision instructions (Option A card)
//   prd-gen-step (phase prd)         → { approved: true|false }
//   roadmap-gen-step                 → { approved: true|false }
//   tasks-gen-step                   → { confirmed: true|false }
//
// Response (next phase suspended):
//   { phase, runId, stepId, questions?, prdId?, planId?, title?, taskCount? }
//
// Response (all phases complete):
//   { phase: 'done' }

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

  const { runId, stepId, answers, revise, approved = true, confirmed = true } = await c.req.json() as {
    runId: string; stepId: string; answers?: string; revise?: string; approved?: boolean; confirmed?: boolean
  }
  if (!runId || !stepId) return c.json({ error: 'runId and stepId required' }, 400)

  const requestContext = new RequestContext()
  requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
  requestContext.set('tenantId', tenantId)
  requestContext.set('userId', userId)
  requestContext.set('agentId', agentId)

  const resumeData = stepId === 'tasks-gen-step'
    ? { confirmed }
    : answers !== undefined ? { answers }   // prd-clarify phase: clarification answers
    : revise  !== undefined ? { revise }    // prd phase: revision instructions (Option A card)
    : { approved }

  try {
    const wf  = mastra.getWorkflow('pm-workflow')
    const run = wf.createRun({ runId })
    const result = await run.resume({ resumeData, step: stepId, requestContext })

    if (result.status === 'suspended') {
      const suspended = getSuspendedStep(result)
      if (!suspended) return c.json({ error: 'Could not determine suspended step' }, 500)

      const sp = suspended.suspendPayload as any
      return c.json({
        phase: sp.phase,
        runId,
        stepId: suspended.stepId,
        questions: sp.questions,   // prd-clarify phase
        prdId: sp.prdId,           // prd phase
        planId: sp.planId,         // roadmap / tasks phase
        title: sp.title,
        taskCount: sp.taskCount,
      }, 200, hdrs)
    }

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
