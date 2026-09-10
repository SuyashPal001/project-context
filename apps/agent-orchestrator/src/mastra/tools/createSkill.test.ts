import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

const VALID_BODY = '---\nname: bid-writer\ndescription: Use when writing bids for prospective clients\n---\n\nOpen with the client name.'

/** Mirrors the tool's own copy — see its comment for why it isn't imported. */
const MAX_COMPOSED_SKILL_CHARS = 24_000

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
    expect(result.error).toMatch(/missing required field 'description'/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Mirrors MIN_DESCRIPTION_LENGTH in skillManifest.ts — a description present
  // but under 20 trimmed characters gives skill_search nothing to match a task
  // against, and must be caught here (before the user approves) rather than
  // surfacing minutes later as a `failed` import row.
  it('rejects a body whose description is present but too short, with a message distinct from "missing"', async () => {
    const result = await run({ name: 'Bid Writer', body: '---\nname: x\ndescription: too short\n---\n\nBody.' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too short to be useful/)
    expect(result.error).not.toMatch(/missing required field/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Long enough to pass the length floor but summarizes what the skill does
  // rather than when to use it — the length check alone would let this through.
  it('rejects a description that is long enough but never says "when"', async () => {
    const result = await run({ name: 'Bid Writer', body: '---\nname: x\ndescription: Formats client bids as a PDF document\n---\n\nBody.' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/should say when to use/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body over 64KB', async () => {
    const result = await run({ name: 'Big', body: `---\nname: a\ndescription: b\n---\n\n${'x'.repeat(65_537)}` })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A body over the 24,000-char composition budget is guaranteed to be dropped
  // by the import worker's budget check — with a log only, after this tool has
  // already told the user the skill will attach. Rejecting it here makes it a
  // retryable error the agent can fix by writing something shorter.
  it('rejects a body that could never fit the composition budget, retryably', async () => {
    const body = `---\nname: a\ndescription: b\n---\n\n${'x'.repeat(24_000)}`
    const result = await run({ name: 'Bid Writer', body })
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toMatch(/too long|shorter/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a body sitting exactly on the composition budget', async () => {
    const frontmatter = '---\nname: a\ndescription: Use when writing bids for prospective clients\n---\n\n'
    // body.length + name.length + 15 === MAX_COMPOSED_SKILL_CHARS — the last
    // size that composes, so the boundary is inclusive rather than off by one.
    const filler = MAX_COMPOSED_SKILL_CHARS - 'Bid Writer'.length - 15 - frontmatter.length
    const result = await run({ name: 'Bid Writer', body: frontmatter + 'x'.repeat(filler) })
    expect(result.success).toBe(true)
  })

  // Without a live SSE session the tool refuses outright — there is no card
  // to have shown, approved or not.
  it('refuses when there is no live session', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY }, execContext({ sendEvent: undefined }))
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // This tool's own guard must cover every identifier a live session implies,
  // not a subset — sendEvent present but sessionId missing must still refuse.
  it('refuses when sendEvent is present but sessionId is missing', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY }, execContext({ sessionId: undefined }))
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates the skill directly — approval already happened before execute() runs', async () => {
    const result = await run({ name: 'Bid Writer', description: 'Writes bids', body: VALID_BODY })

    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.test/api/v1/internal/skills')
    expect(init.headers['x-internal-service-key']).toBe('test-key')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', agentId: 'agent-1', name: 'Bid Writer' })
  })

  // The reply that creates a skill cannot be shaped by it: skills load once at
  // stream start. Saying so is the difference between "working" and "broken".
  //
  // A 202 means created and queued, not attached — attachment happens later
  // in the import worker, which can legitimately skip it (cap overflow,
  // zero-row race) with no chat-visible signal. The success copy must not
  // claim the attach already happened.
  it('tells the user the skill applies from their next message, without claiming it is already attached', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.message).toMatch(/next message/i)
    expect(result.message).not.toMatch(/\battached\b/i)
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

  // Pins the security property the API route's permission check depends on:
  // the model can never name a tenantId/userId/agentId/conversationId — those
  // come only from execContext.requestContext. A future edit adding any of
  // them back to the input schema should fail this test loudly.
  it('exposes only name, description and body on the input schema — never identifiers from the session', async () => {
    const { createSkillInputSchema } = await import('./createSkill.js')
    const keys = Object.keys(createSkillInputSchema.shape)
    expect(keys.sort()).toEqual(['body', 'description', 'name'])
    expect(keys).not.toContain('tenantId')
    expect(keys).not.toContain('userId')
    expect(keys).not.toContain('agentId')
    expect(keys).not.toContain('conversationId')
  })
})

describe('createSkillTool.requireApproval', () => {
  it('requires approval for a valid draft', async () => {
    const { createSkillTool } = await import('./createSkill.js')
    const result = await (createSkillTool.requireApproval as (input: unknown, ctx: unknown) => Promise<boolean>)({ name: 'x', body: VALID_BODY }, {})
    expect(result).toBe(true)
  })

  it('skips approval for an invalid draft (no frontmatter)', async () => {
    const { createSkillTool } = await import('./createSkill.js')
    const result = await (createSkillTool.requireApproval as (input: unknown, ctx: unknown) => Promise<boolean>)({ name: 'x', body: 'no frontmatter here' }, {})
    expect(result).toBe(false)
  })
})
