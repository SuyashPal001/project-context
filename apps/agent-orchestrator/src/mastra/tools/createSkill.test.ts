import { describe, it, expect, vi, beforeEach } from 'vitest'

const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('./confirmGeneration.js', () => ({ confirmGenerationOrDecline: confirmMock }))

const fetchMock = vi.hoisted(() => vi.fn())

const VALID_BODY = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nOpen with the client name.'

function execContext(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    tenantId: 'tenant-1', userId: 'user-1', agentId: 'agent-1',
    conversationId: 'conv-1', sessionId: 'sess-1',
    sendEvent: vi.fn(), ...over,
  }
  return { requestContext: { get: (k: string) => values[k] } }
}

// Two-arg call — matches this repo's actual createTool execute convention
// (see generateVideo.test.ts), not a single merged {context, ...} object.
async function run(args: Record<string, unknown>, ctx = execContext()) {
  const { createSkillTool } = await import('./createSkill.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (createSkillTool as any).execute(args, ctx)
}

describe('create_skill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    process.env.INTERNAL_SERVICE_KEY = 'test-key'
    process.env.API_BASE_URL = 'https://api.test'
    confirmMock.mockResolvedValue({ confirmed: true })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { skillId: 'skill-1', installId: 'install-1' } }), { status: 202 }))
  })

  it('rejects a body with no frontmatter without calling the API', async () => {
    const result = await run({ name: 'Bid Writer', body: 'just prose' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/frontmatter/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body missing the description field', async () => {
    const result = await run({ name: 'Bid Writer', body: '---\nname: x\n---\n\nBody.' })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body over 64KB', async () => {
    const result = await run({ name: 'Big', body: `---\nname: a\ndescription: b\n---\n\n${'x'.repeat(65_537)}` })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Without a live SSE session the confirm gate auto-approves, which would mean
  // unattended writes into the tenant's library.
  it('refuses when there is no live session', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY }, execContext({ sendEvent: undefined }))
    expect(result.success).toBe(false)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for confirmation with alwaysAsk and creates on approval', async () => {
    const result = await run({ name: 'Bid Writer', description: 'Writes bids', body: VALID_BODY })

    expect(confirmMock).toHaveBeenCalledWith(
      expect.anything(), 'skill_creation', 'create', expect.stringContaining('Bid Writer'),
      { alwaysAsk: true },
    )
    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.test/api/v1/internal/skills')
    expect(init.headers['x-internal-service-key']).toBe('test-key')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', agentId: 'agent-1', name: 'Bid Writer' })
  })

  // The reply that creates a skill cannot be shaped by it: skills load once at
  // stream start. Saying so is the difference between "working" and "broken".
  it('tells the user the skill applies from their next message', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.message).toMatch(/next message/i)
  })

  it('returns a terminal result when the user declines', async () => {
    confirmMock.mockResolvedValue({ confirmed: false })
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a terminal result when another confirmation is pending', async () => {
    confirmMock.mockResolvedValue({ confirmed: false, reason: 'CONFIRM_BUSY' })
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(false)
  })

  it('surfaces a quota rejection as a plain message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'QUOTA_EXCEEDED' }), { status: 429 }))
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/limit/i)
  })

  it('surfaces a permission rejection as a plain message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'INSUFFICIENT_PERMISSIONS' }), { status: 403 }))
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission|role/i)
  })

  it('passes PII detections into the confirmation label', async () => {
    const withEmail = '---\nname: a\ndescription: b\n---\n\nMail ada@example.com about it.'
    await run({ name: 'Bid Writer', body: withEmail })
    expect(confirmMock.mock.calls[0][3]).toMatch(/personal|detected/i)
  })
})
