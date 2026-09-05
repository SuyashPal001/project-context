import { describe, it, expect, vi, beforeEach } from 'vitest'

const validateTokenMock = vi.hoisted(() => vi.fn())
vi.mock('../../auth.js', () => ({ validateToken: validateTokenMock }))

const checkCreditBalanceMock = vi.hoisted(() => vi.fn())
const debitChatTurnMock = vi.hoisted(() => vi.fn())
vi.mock('../../credits.js', () => ({
  checkCreditBalance: checkCreditBalanceMock,
  debitChatTurn: debitChatTurnMock,
}))

const persistCostMock = vi.hoisted(() => vi.fn())
vi.mock('../../mastra/cost.js', () => ({ persistCost: persistCostMock }))

const recordUsageMock = vi.hoisted(() => vi.fn())
vi.mock('../../usage.js', () => ({ recordUsage: recordUsageMock }))

vi.mock('../../mastra/model.js', () => ({ platformModel: { modelId: 'gemini-2.5-flash' } }))

const streamTextMock = vi.hoisted(() => vi.fn())
vi.mock('ai', () => ({ streamText: streamTextMock }))

function streamOf(chunks: string[], usage = { inputTokens: 900, outputTokens: 1_800 }) {
  return {
    textStream: (async function* () { for (const c of chunks) yield c })(),
    usage: Promise.resolve(usage),
  }
}

async function readSSE(res: Response): Promise<string> {
  return await res.text()
}

const VALID_CLAIMS = { sub: 'user-1', 'custom:tenantId': 'tenant-1' }
const BODY = { name: 'Bid Writer', brief: 'Help write RFP responses' }

async function request(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer token' }) {
  const { skillsRouter } = await import('../skills.js')
  const { Hono } = await import('hono')
  const app = new Hono()
  app.route('', skillsRouter)
  return app.request('/api/skills/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/skills/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateTokenMock.mockResolvedValue(VALID_CLAIMS)
    checkCreditBalanceMock.mockResolvedValue({ allowed: true, balanceMicro: 100n, unlimited: false })
    streamTextMock.mockReturnValue(streamOf(['---\nname: bid-writer\n', 'description: d\n---\n\nBody.']))
  })

  it('rejects a request with no bearer token', async () => {
    const res = await request(BODY, {})
    expect(res.status).toBe(401)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('rejects a request whose token fails validation', async () => {
    validateTokenMock.mockRejectedValue(new Error('bad token'))
    const res = await request(BODY)
    expect(res.status).toBe(401)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('rejects a body with no brief', async () => {
    const res = await request({ name: 'Bid Writer' })
    expect(res.status).toBe(400)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('returns 402 before streaming when the tenant is out of credits', async () => {
    checkCreditBalanceMock.mockResolvedValue({ allowed: false, balanceMicro: 0n, unlimited: false })
    const res = await request(BODY)
    expect(res.status).toBe(402)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('streams the generated text as delta events and ends with done', async () => {
    const res = await request(BODY)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const text = await readSSE(res)
    expect(text).toContain('event: delta')
    expect(text).toContain('bid-writer')
    expect(text.trimEnd().endsWith('}')).toBe(true)
    expect(text).toContain('event: done')
  })

  // The tenant a caller can spend against must come from the signed token, not
  // from anything the caller can type.
  it('debits the tenant from the token claim, ignoring a tenantId in the body', async () => {
    const res = await request({ ...BODY, tenantId: 'tenant-999' })
    await readSSE(res)
    expect(debitChatTurnMock).toHaveBeenCalledTimes(1)
    expect(debitChatTurnMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      agentId: 'skill-generator',
      model: 'gemini-2.5-flash',
      inputTokens: 900,
      outputTokens: 1_800,
    })
    expect(debitChatTurnMock.mock.calls[0][0].messageId).toMatch(/^skillgen:/)
  })

  it('records usage and cost alongside the debit', async () => {
    const res = await request(BODY)
    await readSSE(res)
    expect(persistCostMock).toHaveBeenCalledTimes(1)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
  })

  it('emits an error event and no debit when the model stream throws', async () => {
    streamTextMock.mockReturnValue({
      textStream: (async function* () { throw new Error('gateway down') })(),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    })
    const res = await request(BODY)
    const text = await readSSE(res)
    expect(text).toContain('event: error')
    expect(text).not.toContain('gateway down')  // internal detail stays server-side
    expect(debitChatTurnMock).not.toHaveBeenCalled()
  })
})
