const API_BASE = process.env.API_BASE_URL ?? ''

function authHeaders(idToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json',
  }
}

export async function createConversation(idToken: string, agentId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversations`, {
      method: 'POST',
      headers: authHeaders(idToken),
      body: JSON.stringify({ agentId }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('[persistence] createConversation failed:', res.status, text)
      return null
    }
    const json = await res.json() as { data?: { id?: string } }
    const id = json.data?.id
    if (!id) {
      console.error('[persistence] createConversation: missing id in response')
      return null
    }
    return id
  } catch (err) {
    console.error('[persistence] createConversation error:', (err as Error).message)
    return null
  }
}

export function saveUserMessage(
  idToken: string,
  conversationId: string,
  content: string,
  attachments?: Array<{ fileId?: string; name: string; type: string; size?: number }>
): void {
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/save`, {
    method: 'POST',
    // Both: the user token identifies the conversation owner, the service key
    // proves this is the relay rather than a user posting forged assistant text.
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ role: 'user', content, attachments: attachments ?? [], createdAt: new Date().toISOString() }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] saveUserMessage status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] saveUserMessage status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] saveUserMessage error:', err.message)
  })
}

function serviceKeyHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '',
  }
}

export interface ArtifactRefPayload {
  type: 'prd' | 'roadmap' | 'tasks'
  entityId: string
  title: string
  // Mastra HITL: workflow runId + current suspended stepId for approval-gate resumption
  pmRunId?: string
  pmStepId?: string
}

export interface CompletedTracePayload {
  elapsedSec: number
  toolCallCount: number
  reasoningText?: string
  reasoningElapsedSec?: number
}

export interface ClarificationQuestion {
  prompt: string
  options: Array<{ label: string; rationale?: string }>
  allowFreeText?: boolean
  allowSkip?: boolean
}

export interface ClarificationRequestPayload {
  id: string
  questions: ClarificationQuestion[]
  status: 'pending' | 'answered' | 'skipped'
  answers?: Record<number, { selectedIndex?: number; freeText?: string; skipped?: boolean }>
  answeredAt?: string
}

export function saveClarificationRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  clarificationRequest: ClarificationRequestPayload,
): void {
  const payload = {
    id: messageId,
    role: 'assistant',
    content: '',
    clarificationRequest,
    createdAt: new Date().toISOString(),
  }
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/save`, {
    method: 'POST',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] saveClarificationRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] saveClarificationRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] saveClarificationRequest error:', err.message)
  })
}

export function updateClarificationRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  update: Pick<ClarificationRequestPayload, 'status' | 'answers' | 'answeredAt'>,
): void {
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/${messageId}/clarification`, {
    method: 'PATCH',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ clarificationRequest: update }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] updateClarificationRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] updateClarificationRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] updateClarificationRequest error:', err.message)
  })
}

export interface ApprovalRequestPayload {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  description: string
  status: 'pending' | 'approved' | 'dismissed'
  decisionAt?: string
}

export function saveApprovalRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  approvalRequest: ApprovalRequestPayload,
): void {
  const payload = {
    id: messageId,
    role: 'assistant',
    content: '',
    approvalRequest,
    createdAt: new Date().toISOString(),
  }
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/save`, {
    method: 'POST',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] saveApprovalRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] saveApprovalRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] saveApprovalRequest error:', err.message)
  })
}

export function updateApprovalRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  update: Pick<ApprovalRequestPayload, 'status' | 'decisionAt'>,
): void {
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/${messageId}/approval`, {
    method: 'PATCH',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ approvalRequest: update }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] updateApprovalRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] updateApprovalRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] updateApprovalRequest error:', err.message)
  })
}

export function saveAssistantMessage(
  idToken: string,
  conversationId: string,
  content: string,
  messageId?: string,
  artifactRef?: ArtifactRefPayload | null,
  completedTrace?: CompletedTracePayload | null,
): void {
  const payload: Record<string, unknown> = {
    role: 'assistant',
    content,
    createdAt: new Date(Date.now() + 1000).toISOString(),
  }
  if (messageId) payload.id = messageId
  if (artifactRef) payload.artifactRef = artifactRef
  if (completedTrace) payload.completedTrace = completedTrace
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/save`, {
    method: 'POST',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] saveAssistantMessage status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] saveAssistantMessage status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] saveAssistantMessage error:', err.message)
  })
}

export function fireArtifactNotification(
  tenantId: string,
  userId: string,
  artifact: ArtifactRefPayload,
): void {
  fetch(`${API_BASE}/api/v1/internal/artifacts/notify`, {
    method: 'POST',
    headers: serviceKeyHeaders(),
    body: JSON.stringify({ tenantId, userId, artifactType: artifact.type, entityId: artifact.entityId, title: artifact.title }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] fireArtifactNotification status: ${res.status} body: ${body}`)
    }
  }).catch((err: Error) => {
    console.error('[persistence] fireArtifactNotification error:', err.message)
  })
}
