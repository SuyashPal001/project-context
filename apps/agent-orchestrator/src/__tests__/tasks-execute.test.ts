import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_KEY = 'test-key'
  process.env.OPENCLAW_GATEWAY_URL = 'ws://localhost:9999'
})

const MockOpenClawClient = vi.hoisted(() =>
  vi.fn().mockImplementation((opts: any) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    patchSessionMcp: vi.fn().mockResolvedValue(undefined),
    patchSessionModel: vi.fn(),
    setActorId: vi.fn(),
    resolveApproval: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() => {
      // Synchronously fires onDone with prose — non-JSON, toolName present → guard fires
      opts.onDone('This is plain prose with absolutely no JSON structure whatsoever.')
    }),
  }))
)

vi.mock('../openclaw.js', () => ({ OpenClawClient: MockOpenClawClient }))
vi.mock('../usage.js', () => ({
  checkMessageQuota: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 100, unlimited: false }),
  fetchAgentModelId: vi.fn().mockResolvedValue(null),
  fetchAgentSlug: vi.fn().mockResolvedValue(null),
  recordUsage: vi.fn(),
}))
vi.mock('../auth.js', () => ({ validateToken: vi.fn() }))
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

describe('POST /api/tasks/execute — non-JSON step output guard', () => {
  it('calls /fail not /complete when LLM returns prose and step.toolName is set', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const body = String(url).includes('/integrations/') ? { data: [] } : []
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const res = await app.request('/api/tasks/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': 'test-key',
      },
      body: JSON.stringify({
        taskId: 'task-1',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        taskTitle: 'Test task',
        taskDescription: 'Do something',
        steps: [{
          id: 'step-1',
          title: 'Search for data',
          toolName: 'web_search',
          stepOrder: 1,
          parameters: {},
          status: 'pending',
        }],
      }),
    })

    expect(res.status).toBe(200)

    // Allow the fire-and-forget runTaskSteps to drain
    await new Promise(resolve => setTimeout(resolve, 50))

    const calledUrls = mockFetch.mock.calls.map(([url]: [string]) => String(url))
    expect(calledUrls.some(u => u.includes('/fail'))).toBe(true)
    expect(calledUrls.some(u => u.includes('/complete'))).toBe(false)
  })
})
