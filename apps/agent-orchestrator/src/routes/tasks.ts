import { Hono } from 'hono'
import { INTERNAL_SERVICE_KEY } from '../types.js'
import { createPlanFromPrd, type PrdData } from '../services/planService.js'
import type { TaskStep, WorkflowStep } from '../types.js'
import { checkMessageQuota, getPool, recordUsage } from '../usage.js'
import { filterPII } from '../pii-filter.js'
import { runMastraTaskSteps } from './tasks.execution.js'
import type { PlanResult } from './tasks.execution.js'
import { runMastraWorkflowSteps } from './tasks.workflow.js'
import { callInternalTaskApi, postTaskComment } from './tasks.helpers.js'

// Re-export for documents.ts and any other consumers
export { fetchTaskComments } from './tasks.helpers.js'
export { buildStepPrompt, extractClarificationQuestion } from './tasks.prompt.js'
export { fetchTenantMcpServers } from './tasks.helpers.js'

// ─── Routes ───────────────────────────────────────────────────────────────────

export const tasksRouter = new Hono()

tasksRouter.post('/api/tasks/execute', async (c) => {
  const serviceKey = c.req.header('x-internal-service-key') ?? ''
  if (!serviceKey || serviceKey !== INTERNAL_SERVICE_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: { taskId?: unknown; agentId?: unknown; tenantId?: unknown; steps?: unknown; taskTitle?: unknown; taskDescription?: unknown; agentName?: unknown; referenceText?: unknown; links?: unknown; attachmentContext?: unknown; acceptanceCriteria?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const steps: TaskStep[] = Array.isArray(body.steps) ? body.steps as TaskStep[] : []
  const rawTaskTitle = typeof body.taskTitle === 'string' ? body.taskTitle.trim() : ''
  const rawTaskDescription = typeof body.taskDescription === 'string' ? body.taskDescription.trim() : ''
  const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : 'Agent'
  const rawReferenceText = typeof body.referenceText === 'string' && body.referenceText.trim() ? body.referenceText.trim() : null
  const rawAttachmentContext = typeof body.attachmentContext === 'string' && body.attachmentContext.trim() ? body.attachmentContext.trim() : null
  const rawAcceptanceCriteria = typeof body.acceptanceCriteria === 'string' && body.acceptanceCriteria.trim() ? body.acceptanceCriteria.trim() : null
  const links = Array.isArray(body.links) ? (body.links as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim() !== '') : null

  const { sanitized: taskTitle, detections: taskTitleD } = filterPII(rawTaskTitle)
  const { sanitized: taskDescription, detections: taskDescD } = filterPII(rawTaskDescription)
  const execRefResult = rawReferenceText !== null ? filterPII(rawReferenceText) : null
  const execAttResult = rawAttachmentContext !== null ? filterPII(rawAttachmentContext) : null
  const execAcResult = rawAcceptanceCriteria !== null ? filterPII(rawAcceptanceCriteria) : null
  const referenceText = execRefResult?.sanitized ?? null
  const attachmentContext = execAttResult?.sanitized ?? null
  const acceptanceCriteria = execAcResult?.sanitized ?? null
  const execPiiDetections = [...taskTitleD, ...taskDescD, ...(execRefResult?.detections ?? []), ...(execAttResult?.detections ?? []), ...(execAcResult?.detections ?? [])]
  if (execPiiDetections.length > 0) {
    const summary = execPiiDetections.reduce((acc, d) => { acc[d.type] = (acc[d.type] ?? 0) + d.count; return acc }, {} as Record<string, number>)
    console.log(`[pii-filter] tasks/execute taskId=${taskId} masked: ${Object.entries(summary).map(([t, c]) => `${t}×${c}`).join(' ')}`)
  }

  if (!taskId || !tenantId || steps.length === 0) {
    return c.json({ error: 'taskId, tenantId, and steps are required' }, 400)
  }

  const execQuota = await checkMessageQuota(tenantId)
  if (!execQuota.allowed) {
    console.warn(`[tasks] tenantId=${tenantId} taskId=${taskId} quota exceeded used=${execQuota.used} limit=${execQuota.limit}`)
    return c.json({ error: 'Message quota exceeded', used: execQuota.used, limit: execQuota.limit }, 429)
  }

  const traceId = c.req.header('x-trace-id') ?? crypto.randomUUID()
  console.log(JSON.stringify({ level: 'info', msg: 'task execution started', traceId, taskId, tenantId, steps: steps.length, ts: Date.now() }))

  // Document workflow branch — PRD attached, no links: run synchronously to return planResult
  const isDocWorkflow = !!(attachmentContext) && (!links || links.length === 0)
  if (isDocWorkflow) {
    const result = await runMastraTaskSteps(taskId, agentId, tenantId, steps, taskTitle, taskDescription, agentName, referenceText, links, attachmentContext, acceptanceCriteria, traceId)
    return c.json({ ok: true, taskId, planResult: result.planResult as PlanResult | undefined })
  }

  // Standard task execution — fire-and-forget
  runMastraTaskSteps(taskId, agentId, tenantId, steps, taskTitle, taskDescription, agentName, referenceText, links, attachmentContext, acceptanceCriteria, traceId).catch((err: Error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'mastra unhandled error', traceId, taskId, tenantId, error: err.message, ts: Date.now() }))
  })
  return c.json({ ok: true, taskId })
})

// ─── Mastra workflow resume endpoint ──────────────────────────────────────────

tasksRouter.post('/api/tasks/:taskId/resume', async (c) => {
  const serviceKey = c.req.header('x-internal-service-key') ?? ''
  if (!serviceKey || serviceKey !== INTERNAL_SERVICE_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const taskId = c.req.param('taskId')
  const traceId = c.req.header('x-trace-id') ?? crypto.randomUUID()
  const p = getPool()

  const taskRes = await p.query<{ mastra_run_id: string | null; tenant_id: string; agent_id: string | null }>(
    `SELECT mastra_run_id, tenant_id, agent_id FROM agent_tasks WHERE id = $1 LIMIT 1`,
    [taskId]
  )
  const task = taskRes.rows[0]
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!task.mastra_run_id) return c.json({ error: 'No suspended workflow run for this task' }, 404)

  const { mastra_run_id: mastraRunId, tenant_id: tenantId, agent_id: agentId } = task

  const stepsRes = await p.query<{ id: string; step_number: number; title: string }>(
    `SELECT id, step_number, title FROM task_steps WHERE task_id = $1 AND status IN ('running', 'pending') ORDER BY step_number ASC`,
    [taskId]
  )
  const runningSteps = stepsRes.rows

  type ResumeResult = { status: string; result?: { summary?: string; status?: string; reasoning?: string; inputTokens?: number; outputTokens?: number }; error?: { message?: string } }
  let resumeResult: ResumeResult = { status: 'pending' }
  try {
    const relayPort = process.env.PORT ?? '3001'
    const resumeUrl = `http://localhost:${relayPort}/studio/workflows/taskExecution/resume?runId=${mastraRunId}`
    const resumeRes = await fetch(resumeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'approval', resumeData: { approved: true } }),
    })
    if (!resumeRes.ok) {
      throw new Error(`Studio resume returned ${resumeRes.status}: ${await resumeRes.text()}`)
    }
    console.log(`[mastra/resume] Studio resume triggered runId=${mastraRunId}`)

    const pollUrl = `http://localhost:${relayPort}/studio/workflows/taskExecution/runs/${mastraRunId}`
    let settled = false
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10000))
      let pollData: Record<string, unknown>
      try {
        const pollRes = await fetch(pollUrl)
        if (!pollRes.ok) { console.warn(`[mastra/resume] poll ${i + 1} non-ok: ${pollRes.status}`); continue }
        pollData = await pollRes.json() as Record<string, unknown>
      } catch (pollErr) {
        console.warn(`[mastra/resume] poll ${i + 1} fetch error:`, (pollErr as Error).message); continue
      }
      const runStatus = pollData.status as string | undefined
      console.log(`[mastra/resume] poll ${i + 1} runId=${mastraRunId} status=${runStatus}`)
      if (runStatus === 'success') {
        resumeResult = { status: 'success', result: pollData.result as ResumeResult['result'] }
        settled = true; break
      }
      if (runStatus === 'failed' || runStatus === 'error') {
        const errMsg = typeof pollData.error === 'object' && pollData.error !== null
          ? ((pollData.error as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(pollData.error)
          : String(pollData.error ?? 'Workflow failed after resume')
        resumeResult = { status: 'failed', error: { message: errMsg } }
        settled = true; break
      }
    }
    if (!settled) resumeResult = { status: 'failed', error: { message: 'Workflow resume timed out after 10 minutes' } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[mastra/resume] tenantId=${tenantId} taskId=${taskId} resume error:`, message)
    await postTaskComment(taskId, `❌ Resume failed: ${message}`, agentId ?? 'system')
    await callInternalTaskApi(`/internal/tasks/${taskId}/fail`, { error: message }, traceId)
    return c.json({ error: message }, 500)
  }

  if (resumeResult.status === 'success') {
    const totalInputTokens = resumeResult.result?.inputTokens ?? 0
    const totalOutputTokens = resumeResult.result?.outputTokens ?? 0
    const stepMessages = [
      'Analyzing task and generating search strategy...',
      'Searching across multiple sources in parallel...',
      'Merging and deduplicating results...',
    ]
    for (let i = 0; i < runningSteps.length - 1; i++) {
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${runningSteps[i].id}/complete`, {
        agentOutput: stepMessages[i] ?? `Step ${i + 1} completed`, summary: stepMessages[i] ?? `Step ${i + 1} completed`,
      }, traceId)
    }
    if (runningSteps.length > 0) {
      const lastStep = runningSteps[runningSteps.length - 1]
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${lastStep.id}/complete`, {
        agentOutput: resumeResult.result?.summary ?? '', summary: resumeResult.result?.summary ?? '',
        reasoning: resumeResult.result?.reasoning ?? undefined, actualToolUsed: 'internet_search',
      }, traceId)
    }
    await postTaskComment(taskId, `✅ All steps completed.`, agentId ?? 'system')
    await callInternalTaskApi(`/internal/tasks/${taskId}/complete`, { summary: 'All steps completed successfully.' }, traceId)
    recordUsage({ tenantId, actorId: agentId ?? 'system', inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
  } else {
    const message = resumeResult.error?.message ?? 'Workflow failed after resume'
    console.error(`[mastra/resume] tenantId=${tenantId} taskId=${taskId} workflow failed:`, message)
    for (const step of runningSteps) {
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${step.id}/fail`, { error: message }, traceId)
    }
    await postTaskComment(taskId, `❌ Task failed: ${message}`, agentId ?? 'system')
    await callInternalTaskApi(`/internal/tasks/${taskId}/fail`, { error: message }, traceId)
    return c.json({ error: message }, 500)
  }

  return c.json({ ok: true })
})

tasksRouter.post('/api/workflows/execute', async (c) => {
  const serviceKey = c.req.header('x-internal-service-key') ?? ''
  if (!serviceKey || serviceKey !== INTERNAL_SERVICE_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: { workflowId?: unknown; workflowRunId?: unknown; tenantId?: unknown; agentId?: unknown; steps?: unknown; systemPrompt?: unknown; requiresApproval?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : ''
  const workflowRunId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : ''
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const steps: WorkflowStep[] = Array.isArray(body.steps) ? body.steps as WorkflowStep[] : []
  const systemPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim() ? body.systemPrompt.trim() : null
  const requiresApproval = body.requiresApproval === true

  if (!workflowId || !workflowRunId || !tenantId || !agentId) {
    return c.json({ error: 'workflowId, workflowRunId, tenantId, and agentId are required' }, 400)
  }

  const quota = await checkMessageQuota(tenantId)
  if (!quota.allowed) {
    console.warn(`[workflows] tenantId=${tenantId} workflowId=${workflowId} quota exceeded used=${quota.used} limit=${quota.limit}`)
    return c.json({ error: 'Message quota exceeded', used: quota.used, limit: quota.limit }, 429)
  }

  const traceId = c.req.header('x-trace-id') ?? crypto.randomUUID()
  console.log(JSON.stringify({ level: 'info', msg: 'workflow execution started', traceId, workflowId, workflowRunId, tenantId, steps: steps.length, ts: Date.now() }))

  runMastraWorkflowSteps(workflowId, workflowRunId, agentId, tenantId, steps, systemPrompt, requiresApproval, traceId).catch((err: Error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'workflow unhandled error', traceId, workflowId, workflowRunId, tenantId, error: err.message, ts: Date.now() }))
  })
  return c.json({ ok: true, workflowRunId })
})

// ─── Plan creation from PRD ───────────────────────────────────────────────────

tasksRouter.post('/api/tasks/create-plan', async (c) => {
  let body: { tenantId?: unknown; userId?: unknown; prdData?: unknown }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const userId   = typeof body.userId   === 'string' ? body.userId.trim()   : ''
  const prdData  = body.prdData != null && typeof body.prdData === 'object' && !Array.isArray(body.prdData)
    ? body.prdData as PrdData
    : null

  if (!tenantId || !userId || !prdData) {
    return c.json({ error: 'tenantId, userId, and prdData are required' }, 400)
  }

  const traceId = c.req.header('x-trace-id') ?? crypto.randomUUID()

  try {
    const result = await createPlanFromPrd(tenantId, userId, prdData)
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', msg: 'create-plan failed', traceId, tenantId, error: message, ts: Date.now() }))
    return c.json({ error: message }, 400)
  }
})
