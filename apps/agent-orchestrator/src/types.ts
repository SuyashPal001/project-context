import { join } from 'node:path'
import { homedir } from 'node:os'
import { WebSocket } from 'ws'

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface Attachment {
  fileId?: string
  name?: string
  type?: string
  size?: number
  presignedUrl?: string
}

export interface DownloadedMedia {
  filePath: string
  base64: string
  mimeType: string
  name: string
}

export interface RelaySessionCtx {
  ws: WebSocket
  apiToken: string
  getConversationId: () => string | null
  getPendingUserMessage: () => string
  getPendingAttachments: () => Array<{ fileId?: string; name: string; type: string; size?: number }>
}

export interface TaskStep {
  id: string
  stepOrder: number
  title: string
  description: string
  toolName: string
  parameters: Record<string, unknown>
}

export interface TaskComment {
  id?: string
  content: string
  authorName?: string
  agentId?: string
  createdAt?: string
}

export interface CompletedStep {
  title: string
  agentOutput: string
  results: Array<{ title: string; url: string; description: string }>
  reasoning: string
  summary: string
}

export interface WorkflowStep {
  id?: string
  stepNumber?: number
  title: string
  description?: string
  toolName?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MEDIA_DIR = join(homedir(), '.project-context', 'media', 'inbound')

export const API_BASE_URL = process.env.API_BASE_URL ?? ''
export const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY ?? ''
export const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? `${API_BASE_URL}/api/v1`

// ─── Shared mutable state ─────────────────────────────────────────────────────

// Session registry (for /agent-response routing)
export const sessions = new Map<string, RelaySessionCtx>()

// Written by /rag/retrieve when it returns chunks; read by the SSE onDone handler.
export const lastRagResult = new Map<string, { chunks: string[]; count: number; ts: number; topScore: number }>()

// MCP write-tool approval state
export const pendingMcpApprovals = new Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout>; tenantId: string }>()

// sseApprovalChannels: orchestrator sessionId → function that sends an SSE event on the open stream
export const sseApprovalChannels = new Map<string, (payload: Record<string, unknown>) => void>()

// Mid-conversation clarification-question state. Generalizes the MCP write-tool
// approval gate above (single boolean) to an ordered array of per-question answers
// collected across a paginated ClarificationCard in the UI.
export interface ClarificationAnswer {
  questionIndex: number
  selectedIndex?: number
  freeText?: string
  skipped?: boolean
}

export const pendingClarifications = new Map<string, {
  resolve: (answers: ClarificationAnswer[]) => void
  timer: ReturnType<typeof setTimeout>
  expectedCount: number
  collected: ClarificationAnswer[]
  tenantId: string
  userId: string
}>()

// ─── Rate limiter ─────────────────────────────────────────────────────────────

export const rateLimitMap = new Map<string, { count: number; windowStart: number }>()
export const RATE_LIMIT_MAX = 30        // max requests per window
export const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute window

export function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) return false
  entry.count++
  return true
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

export const ALLOWED_ORIGINS = new Set([
  'https://projectcontext.co',
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
])

export function getAllowedOrigin(requestOrigin: string | undefined): string {
  if (!requestOrigin) return ''
  if (ALLOWED_ORIGINS.has(requestOrigin)) return requestOrigin
  if (/^https:\/\/[a-zA-Z0-9-]+\.projectcontext\.co$/.test(requestOrigin)) return requestOrigin
  return ''
}

// ─── Conversation history helpers ─────────────────────────────────────────────

export async function fetchConversationHistory(
  conversationId: string,
  accessToken: string,
  limit = 20
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/v1/conversations/${conversationId}/messages?limit=${limit}&order=asc`,
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(`[history] failed to fetch: ${response.status} body: ${body}`)
      if (response.status === 401) throw new Error('AUTH_EXPIRED')
      return []
    }
    const data = await response.json() as { data?: unknown[]; messages?: unknown[] }
    const messages = (data.data ?? data.messages ?? []) as Array<Record<string, unknown>>
    return messages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({ role: msg.role as 'user' | 'assistant', content: typeof msg.content === 'string' ? msg.content : '' }))
  } catch (err) {
    console.error('[history] error fetching:', (err as Error).message)
    return []
  }
}

export function formatHistoryForContext(
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): string {
  if (history.length === 0) return ''
  const formatted = history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n')
  return `<conversation_history>\n${formatted}\n</conversation_history>\n\n`
}
