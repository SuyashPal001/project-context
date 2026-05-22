import { API_BASE_URL, INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from './types.js'

export function fireMetrics(payload: {
  conversationId: string; tenantId: string; ragFired: boolean
  ragChunksRetrieved: number; responseTimeMs: number; totalTokens: number; inputTokens: number; outputTokens: number; userMessageCount: number
  costUsd?: number
}): void {
  fetch(`${API_BASE_URL}/api/v1/internal/evals/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(`[evals] metrics failed: ${res.status} ${t}`)
    } else {
      console.log(`[evals] metrics posted conversationId=${payload.conversationId} ragFired=${payload.ragFired} rtMs=${payload.responseTimeMs}`)
    }
  }).catch((err: Error) => { console.error('[evals] metrics error:', err.message) })
}

export function fireAutoEval(payload: {
  conversationId: string; messageId: string; tenantId: string
  question: string; retrievedChunks: string[]; answer: string
}): void {
  fetch(`${API_BASE_URL}/api/v1/internal/evals/auto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(`[evals] auto eval failed: ${res.status} ${t}`)
    } else {
      console.log(`[evals] auto eval posted conversationId=${payload.conversationId} messageId=${payload.messageId}`)
    }
  }).catch((err: Error) => { console.error('[evals] auto eval error:', err.message) })
}

export function fireToolCallLog(payload: {
  tenantId: string; conversationId: string; userId: string | null; toolName: string
  success: boolean; latencyMs: number; errorMessage?: string; args: Record<string, unknown>
}): void {
  fetch(`${API_BASE_URL}/api/v1/internal/tool-calls/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(`[tool-calls] log failed: ${res.status} ${t}`)
    } else {
      console.log(`[tool-calls] logged tool=${payload.toolName} conversationId=${payload.conversationId} latencyMs=${payload.latencyMs}`)
    }
  }).catch((err: Error) => { console.error('[tool-calls] log error:', err.message) })
}

export function fireKnowledgeGap(payload: {
  tenantId: string; conversationId: string; query: string; ragScore: number
}): void {
  fetch(`${API_BASE_URL}/api/v1/internal/knowledge-gaps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(`[knowledge-gaps] failed: ${res.status} ${t}`)
    } else {
      console.log(`[knowledge-gaps] logged conversationId=${payload.conversationId} ragScore=${payload.ragScore}`)
    }
  }).catch((err: Error) => { console.error('[knowledge-gaps] error:', err.message) })
}

export function fireFairnessAudit(payload: {
  tenantId: string; conversationId: string; messageId: string; agentId: string
  overallStatus: 'pass' | 'warn' | 'fail'
  checkResults: unknown[]
  responseLength: number
  toolsUsed: number
}): void {
  fetch(`${API_BASE_URL}/api/v1/internal/fairness/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error(`[fairness] audit post failed: ${res.status} ${t}`)
    } else {
      console.log(`[fairness:Sutra1] audit posted cid=${payload.conversationId} status=${payload.overallStatus}`)
    }
  }).catch((err: Error) => { console.error('[fairness] audit error:', err.message) })
}

export function fireTaskStepDelta(taskId: string, stepId: string, tenantId: string, delta: string, text: string): void {
  fetch(`${INTERNAL_API_URL}/internal/tasks/${taskId}/steps/${stepId}/delta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({ delta, text, tenantId }),
  }).catch((err: Error) => {
    console.error(`[tasks] delta push error stepId=${stepId}:`, err.message)
  })
}

export function fireTaskStepEvent(taskId: string, stepId: string, payload: Record<string, unknown>): void {
  fetch(`${INTERNAL_API_URL}/internal/tasks/${taskId}/steps/${stepId}/delta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify(payload),
  }).catch((err: Error) => {
    console.error(`[tasks] event push error stepId=${stepId}:`, err.message)
  })
}
