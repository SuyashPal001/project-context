import { Hono } from 'hono'
import { InsufficientCreditsError } from '@serverless-saas/credits'
import { TaskComment, INTERNAL_SERVICE_KEY } from '../types.js'
import { fetchAgentModelSelection, fetchAgentSkills, fetchConnectedProviders } from '../usage.js'
import { chargeTaskEstimate, DEFAULT_TASK_MODEL, estimateTaskMicro, refundTask, resolveTaskRate, settleTask } from '../credits.js'
import { createTenantAgent } from '../mastra/index.js'
import { filterPII } from '../pii-filter.js'
import { fetchTaskComments } from './tasks.helpers.js'
import { isInternalServiceKey } from '../service-key.js'

// ─── Task planning endpoint ───────────────────────────────────────────────────

function buildPlanningPrompt(
  agentName: string,
  title: string,
  description: string,
  acceptanceCriteria: string,
  comments: TaskComment[],
  extraContext?: string,
  referenceText?: string | null,
  links?: string[] | null,
  attachmentContext?: string | null
): string {
  const lines = [
    `<session_context>`,
    `task_planning: ${title}`,
    `</session_context>`,
    ``,
    `You are ${agentName}, an AI agent on this platform.`,
    ``,
    `**Task Title:** ${title}`,
    `**Description:** ${description}`,
    `**Acceptance Criteria:** ${acceptanceCriteria}`,
  ]

  if (referenceText) {
    lines.push(``, `## Reference Material`, `The user provided this reference text for context:`, referenceText)
  }

  if (attachmentContext) {
    lines.push(``, `## Attached Files`, `The user has attached the following files. Use this content to inform your planning:`, attachmentContext)
  }

  if (links && links.length > 0) {
    lines.push(``, `## Relevant Links`, `The user attached these links. Use them as context or fetch their content if needed:`, ...links.map(l => `- ${l}`))
  }

  if (comments.length > 0) {
    lines.push(``, `**Comment History (chronological):**`)
    for (const comment of comments) {
      const author = comment.authorName ?? (comment.agentId ? 'Agent' : 'User')
      const timestamp = comment.createdAt ? ` (${comment.createdAt})` : ''
      lines.push(`- ${author}${timestamp}: ${comment.content}`)
    }
  }

  if (extraContext) {
    lines.push(
      ``,
      `## Previous Plan Feedback`,
      `The user reviewed your previous plan and rejected it with this feedback:`,
      extraContext,
      ``,
      `Your new plan MUST directly address each point of feedback above. Do not repeat the rejected approach.`,
    )
  }

  lines.push(
    ``,
    `Think step by step. Break this task into concrete executable steps. Each step must have a clear tool to use.`,
    ``,
    `If the task is unclear or missing critical information, respond with this JSON only:`,
    '```json',
    `{ "clarificationNeeded": true, "questions": ["<question1>", "<question2>"] }`,
    '```',
    ``,
    `If the task is clear, respond with a JSON array of steps only:`,
    '```json',
    `[`,
    `  {`,
    `    "title": "Step title",`,
    `    "description": "What this step does",`,
    `    "toolName": "tool_name_or_null",`,
    `    "reasoning": "Why this step is needed",`,
    `    "estimatedHours": 0.5,`,
    `    "confidenceScore": 0.9`,
    `  }`,
    `]`,
    '```',
    ``,
    `Respond with valid JSON only. No prose before or after.`
  )
  return lines.join('\n')
}

function extractPlanJson(
  text: string
): { clarificationNeeded: true; questions: string[] } | { steps: unknown[] } | null {
  // Strip markdown code fences if present
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim()
  try {
    const parsed = JSON.parse(jsonText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.clarificationNeeded === true) {
      return { clarificationNeeded: true, questions: Array.isArray(parsed.questions) ? parsed.questions : [] }
    }
    if (Array.isArray(parsed)) {
      return { steps: parsed }
    }
    return null
  } catch {
    return null
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const documentsRouter = new Hono()

documentsRouter.post('/api/tasks/plan', async (c) => {
  const serviceKey = c.req.header('x-internal-service-key') ?? ''
  if (!isInternalServiceKey(serviceKey)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: {
    taskId?: unknown; agentId?: unknown; tenantId?: unknown
    title?: unknown; description?: unknown; acceptanceCriteria?: unknown; extraContext?: unknown
    agentName?: unknown; referenceText?: unknown; links?: unknown; attachmentContext?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
  const rawDescription = typeof body.description === 'string' ? body.description.trim() : ''
  const rawAC = body.acceptanceCriteria
  const acceptanceCriteria = typeof rawAC === 'string'
    ? rawAC.trim()
    : Array.isArray(rawAC)
      ? (rawAC as Array<{ text?: string }>).map(c => c.text ?? String(c)).filter(Boolean).join('\n')
      : ''
  const extraContext = typeof body.extraContext === 'string' && body.extraContext.trim()
    ? body.extraContext.trim()
    : undefined
  const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : 'Agent'
  const rawPlanReferenceText = typeof body.referenceText === 'string' && body.referenceText.trim() ? body.referenceText.trim() : null
  const rawPlanAttachmentContext = typeof body.attachmentContext === 'string' && body.attachmentContext.trim() ? body.attachmentContext.trim() : null
  const planLinks = Array.isArray(body.links) ? (body.links as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim() !== '') : null

  const { sanitized: title, detections: titlePlanD } = filterPII(rawTitle)
  const { sanitized: description, detections: descPlanD } = filterPII(rawDescription)
  const planRefResult = rawPlanReferenceText !== null ? filterPII(rawPlanReferenceText) : null
  const planAttResult = rawPlanAttachmentContext !== null ? filterPII(rawPlanAttachmentContext) : null
  const planReferenceText = planRefResult?.sanitized ?? null
  const planAttachmentContext = planAttResult?.sanitized ?? null
  const planPiiDetections = [...titlePlanD, ...descPlanD, ...(planRefResult?.detections ?? []), ...(planAttResult?.detections ?? [])]
  if (planPiiDetections.length > 0) {
    const summary = planPiiDetections.reduce((acc, d) => { acc[d.type] = (acc[d.type] ?? 0) + d.count; return acc }, {} as Record<string, number>)
    console.log(`[pii-filter] tasks/plan taskId=${taskId} masked: ${Object.entries(summary).map(([t, c]) => `${t}×${c}`).join(' ')}`)
  }

  if (!taskId || !tenantId || !title) {
    return c.json({ error: 'taskId, tenantId, and title are required' }, 400)
  }

  // Metered like task execution (Task 9), but keyed under a `document:` namespace
  // so this planning charge never collides with the `task:{taskId}` charge that
  // /api/tasks/execute makes for the same taskId. jobType: 'document' distinguishes
  // the ledger rows. The charge IS the check — chargeTaskEstimate throws
  // InsufficientCreditsError under the account lock when the estimate can't be
  // covered; no separate balance pre-check here (see credits.ts's comment on why).
  const planModelSelection = await fetchAgentModelSelection(agentId)
  const planModel = planModelSelection?.model ?? DEFAULT_TASK_MODEL
  const planEstimateMicro = await estimateTaskMicro(1, planModel)
  const planRate = await resolveTaskRate(planModel)
  try {
    await chargeTaskEstimate({
      tenantId, taskId, agentId, estimateMicro: planEstimateMicro,
      rateId: planRate?.id ?? null, rateVersion: planRate?.version ?? null,
      key: `document:${taskId}`, jobType: 'document',
    })
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} insufficient credits for estimate=${planEstimateMicro}`)
      return c.json({ error: 'Insufficient credits' }, 402)
    }
    throw err
  }

  console.log(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} title="${title}"`)

  const comments = await fetchTaskComments(taskId)
  const prompt = buildPlanningPrompt(agentName, title, description, acceptanceCriteria, comments, extraContext, planReferenceText, planLinks, planAttachmentContext)

  // Fetch agent config — same pattern as execution path
  const planSkill = await fetchAgentSkills(agentId, tenantId)
  const planInstructions = planSkill.systemPrompt
    ?? `You are ${agentName}, a helpful AI assistant.`
  const planConnectedProviders = await fetchConnectedProviders(tenantId)

  const { agent: planAgent, mcpClient: planMcpClient } = await createTenantAgent({
    tenantId,
    agentId,
    agentSlug: agentId,
    instructions: planInstructions,
    connectedProviders: planConnectedProviders,
    // enabledTools has had no reader since platformAgent's tools resolver
    // (Composio/MCP + SERVER_TOOL_NAMES gate on tenantId, not this field) —
    // it's vestigial. This was one of its three producers; all three now
    // hardcode null, so the field is permanently null.
    enabledTools: null,
  })

  // threadId must never be undefined — Mastra memory requires both threadId and resourceId.
  // taskId is validated non-empty above; fallback is a safety net only.
  const planThreadId = taskId || `plan:${tenantId}:${Date.now()}`
  if (!planThreadId) throw new Error('threadId required for Mastra memory')

  let agentOutput = ''
  try {
    const result = await planAgent.generate(prompt, {
      memory: { thread: planThreadId, resource: tenantId },
    })
    agentOutput = result.text ?? ''
    // The Mastra generate() result reports real token totals here (same
    // result.usage shape read at every other agent.generate() call site in
    // this codebase), so settle against them now rather than leaving the
    // up-front estimate as the final charge on a successful run. Unlike
    // every other settleTask call site, this one is AWAITED rather than
    // fire-and-forget: this route (unlike tasks.ts's background job) decides
    // synchronously, a few lines below, whether to also call refundTask on
    // an empty response — refundTask's settled-row guard only prevents a
    // double-adjustment if the settle it's checking for has actually landed
    // by the time it runs. Firing this without awaiting would race that
    // guard and could let both a settle and a full refund apply to the same
    // charge.
    await settleTask({
      tenantId, taskId, agentId, model: planModel,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      chargeKey: `document:${taskId}`, key: `document:${taskId}:settle`, jobType: 'document',
    })
  } catch (err) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} Mastra error:`, (err as Error).message)
    // No token totals exist when generate() itself throws, so there is
    // nothing to settle against — but the plan delivered zero work, so the
    // estimate charged above must not stand. Refund it, mirroring tasks.ts's
    // refundTask calls on the same failure semantics.
    await refundTask({ tenantId, taskId, chargeKey: `document:${taskId}`, jobType: 'document' })
    return c.json({ error: 'Agent error', detail: (err as Error).message }, 502)
  } finally {
    await planMcpClient.disconnect()
  }

  if (!agentOutput) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} empty response`)
    // The plan delivered zero usable work, so refund what was charged — but
    // settleTask already ran above and may have already reconciled this
    // charge to real token usage (generate() succeeded; an empty *text*
    // result doesn't mean zero tokens were spent producing it). refundTask
    // itself is what decides whether there is anything left to undo: its
    // settled-row check skips entirely once a settle row exists for this
    // chargeKey (that reconciliation stands as final), and otherwise its
    // ledger-balance check only refunds a nonzero remaining debit. Because
    // settleTask was awaited above rather than fired-and-forgotten, that
    // settled-row check is race-free by the time refundTask runs it.
    await refundTask({ tenantId, taskId, chargeKey: `document:${taskId}`, jobType: 'document' })
    return c.json({ error: 'Agent returned empty response' }, 502)
  }

  const plan = extractPlanJson(agentOutput)
  if (!plan) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} JSON parse failed, raw: ${agentOutput.slice(0, 200)}`)
    // Same treatment as the two failure branches above, which this one used to
    // be missing: the caller gets a 502 and no plan, so the charge must not be
    // left standing on the strength of this route having produced *text*.
    // Usually a no-op in practice — settleTask was awaited above and will have
    // written a settle row, which refundTask's settled-row guard honours as the
    // final reconciliation. That makes this the unreconciled case only: the
    // settle was skipped or failed and the estimate is still the live debit.
    await refundTask({ tenantId, taskId, chargeKey: `document:${taskId}`, jobType: 'document' })
    return c.json({ error: 'Failed to parse agent plan', raw: agentOutput }, 502)
  }

  console.log(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} done clarificationNeeded=${'clarificationNeeded' in plan}`)
  return c.json(plan)
})
