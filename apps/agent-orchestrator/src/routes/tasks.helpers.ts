import { INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from '../types.js'
import type { TaskComment } from '../types.js'

export async function callInternalTaskApi(
  path: string,
  body: Record<string, unknown>,
  traceId?: string
): Promise<void> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
        ...(traceId ? { 'x-trace-id': traceId } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[tasks] internal API ${path} returned ${res.status}: ${text}`)
    }
  } catch (err) {
    console.error(`[tasks] internal API ${path} error:`, (err as Error).message)
  }
}

export async function postTaskEval(params: {
  taskId: string
  tenantId: string
  taskTitle: string
  taskDescription: string | undefined
  finalOutput: string
}): Promise<void> {
  try {
    await fetch(`${INTERNAL_API_URL}/internal/evals/auto`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({
        conversationId: params.taskId,
        messageId: params.taskId,
        tenantId: params.tenantId,
        question: params.taskTitle,
        retrievedChunks: [],
        answer: params.finalOutput,
      }),
    })
  } catch (err) {
    // Fire and forget — never block task execution
    console.error('[eval] postTaskEval error:', (err as Error).message)
  }
}

export async function logToolCall(params: {
  tenantId: string
  toolName: string
  success: boolean
  taskId?: string
  latencyMs?: number
  errorMessage?: string
  args?: Record<string, unknown>
}): Promise<void> {
  try {
    await fetch(`${INTERNAL_API_URL}/internal/tool-calls/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify(params),
    })
  } catch (err) {
    // Fire and forget — never block task execution
    console.error('[tool-log] failed to log tool call:', (err as Error).message)
  }
}

export async function fetchTaskComments(taskId: string): Promise<TaskComment[]> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}/internal/tasks/${taskId}/comments`, {
      headers: { 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    })
    if (!res.ok) {
      console.error(`[tasks] comments fetch ${taskId} returned ${res.status}`)
      return []
    }
    const data = await res.json() as TaskComment[] | { data?: TaskComment[]; comments?: TaskComment[] }
    return Array.isArray(data) ? data : (data.data ?? data.comments ?? [])
  } catch (err) {
    console.error(`[tasks] comments fetch error:`, (err as Error).message)
    return []
  }
}

export async function postTaskComment(taskId: string, content: string, agentId: string): Promise<void> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}/internal/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ content, agentId }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[tasks] post comment ${taskId} returned ${res.status}: ${text}`)
    }
  } catch (err) {
    console.error(`[tasks] post comment error:`, (err as Error).message)
  }
}

export async function fetchTenantMcpServers(tenantId: string): Promise<{ provider: string; mcpServerUrl: string }[]> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}/internal/integrations/${tenantId}`, {
      headers: { 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    })
    if (!res.ok) {
      console.error(`[tasks] fetchTenantMcpServers failed status=${res.status} tenantId=${tenantId}`)
      return []
    }
    const data = await res.json() as { data: { provider: string; mcpServerUrl: string | null }[] }
    return data.data
      .filter(i => i.mcpServerUrl != null)
      .map(i => ({ provider: i.provider, mcpServerUrl: i.mcpServerUrl! }))
  } catch (err) {
    console.error('[tasks] fetchTenantMcpServers error:', (err as Error).message)
    return []
  }
}
