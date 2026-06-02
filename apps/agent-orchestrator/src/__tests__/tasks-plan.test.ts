import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_KEY = 'test-key'
})

vi.mock('../usage.js', () => ({
  checkMessageQuota: vi.fn().mockResolvedValue({ allowed: false, used: 100, limit: 100, unlimited: false }),
  fetchAgentModelId: vi.fn(),
  fetchAgentSlug: vi.fn(),
  recordUsage: vi.fn(),
}))
vi.mock('../auth.js', () => ({ validateToken: vi.fn() }))
vi.mock('../openclaw.js', () => ({ OpenClawClient: vi.fn() }))
vi.mock('../persistence.js', () => ({
  createConversation: vi.fn(),
  saveUserMessage: vi.fn(),
  saveAssistantMessage: vi.fn(),
}))
vi.mock('../rag/queryRewrite.js', () => ({ rewriteQuery: vi.fn() }))
vi.mock('../rag/relevanceGate.js', () => ({ gateChunks: vi.fn(), fastGateChunks: vi.fn() }))
vi.mock('../pii-filter.js', () => ({
  filterPII: vi.fn().mockImplementation((text: string) => ({ sanitized: text, detections: [] })),
}))

import { app } from '../app.js'

describe('POST /api/tasks/plan — quota gate', () => {
  it('returns 429 when checkMessageQuota denies the request', async () => {
    const res = await app.request('/api/tasks/plan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': 'test-key',
      },
      body: JSON.stringify({ taskId: 'task-1', tenantId: 'tenant-1', title: 'Test task' }),
    })

    expect(res.status).toBe(429)
    const json = await res.json() as { error: string; used: number; limit: number }
    expect(json.error).toBe('Message quota exceeded')
    expect(json.used).toBe(100)
    expect(json.limit).toBe(100)
  })
})
