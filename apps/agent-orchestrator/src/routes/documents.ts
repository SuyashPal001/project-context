import { Hono } from 'hono'
import { TaskComment, INTERNAL_SERVICE_KEY } from '../types.js'
import { checkMessageQuota, fetchAgentSkill, fetchConnectedProviders } from '../usage.js'
import { createTenantAgent } from '../mastra/index.js'
import { filterPII } from '../pii-filter.js'
import { fetchTaskComments } from './tasks.helpers.js'

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
  if (!serviceKey || serviceKey !== INTERNAL_SERVICE_KEY) {
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

  const planQuota = await checkMessageQuota(tenantId)
  if (!planQuota.allowed) {
    console.warn(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} quota exceeded used=${planQuota.used} limit=${planQuota.limit}`)
    return c.json({ error: 'Message quota exceeded', used: planQuota.used, limit: planQuota.limit }, 429)
  }

  console.log(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} title="${title}"`)

  const comments = await fetchTaskComments(taskId)
  const prompt = buildPlanningPrompt(agentName, title, description, acceptanceCriteria, comments, extraContext, planReferenceText, planLinks, planAttachmentContext)

  // Fetch agent config — same pattern as execution path
  const planSkill = await fetchAgentSkill(agentId)
  const planInstructions = planSkill?.systemPrompt
    ?? `You are ${agentName}, a helpful AI assistant.`
  const planConnectedProviders = await fetchConnectedProviders(tenantId)

  const { agent: planAgent, mcpClient: planMcpClient } = await createTenantAgent({
    tenantId,
    agentId,
    agentSlug: agentId,
    instructions: planInstructions,
    connectedProviders: planConnectedProviders,
    enabledTools: planSkill?.tools ?? null,
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
  } catch (err) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} Mastra error:`, (err as Error).message)
    return c.json({ error: 'Agent error', detail: (err as Error).message }, 502)
  } finally {
    await planMcpClient.disconnect()
  }

  if (!agentOutput) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} empty response`)
    return c.json({ error: 'Agent returned empty response' }, 502)
  }

  const plan = extractPlanJson(agentOutput)
  if (!plan) {
    console.error(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} JSON parse failed, raw: ${agentOutput.slice(0, 200)}`)
    return c.json({ error: 'Failed to parse agent plan', raw: agentOutput }, 502)
  }

  console.log(`[tasks/plan] tenantId=${tenantId} taskId=${taskId} done clarificationNeeded=${'clarificationNeeded' in plan}`)
  return c.json(plan)
})
