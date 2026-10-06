import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))
const { cutSignoff } = vi.hoisted(() => ({ cutSignoff: vi.fn() }))
vi.mock('./jingleCut.js', () => ({ cutSignoff }))
const { mkdtempSync, realMkdtempSync } = vi.hoisted(() => ({ mkdtempSync: vi.fn(), realMkdtempSync: { fn: undefined as unknown as (...a: unknown[]) => string } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  realMkdtempSync.fn = actual.mkdtempSync as unknown as (...a: unknown[]) => string
  mkdtempSync.mockImplementation(actual.mkdtempSync)
  return { ...actual, mkdtempSync }
})

import { generateJingle, JINGLE_MODEL } from './generateJingle.js'
import { uploadGeneratedFile } from '../../persistence.js'
import { stableToolCallId } from '../../credits.js'

const upload = uploadGeneratedFile as ReturnType<typeof vi.fn>
const LYRICS = '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic'
const input = { line: 'Bubbli, feel the magic', lyrics: ['Every bubble, every sip'], style: 'bright pop, female vocal, 120 bpm' }
const gatewayOk = (body: object = { audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: LYRICS }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

function ctx(toolCallId = 'call-1', values: Record<string, string> = { tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' }) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId, messages: [] } } as never
}
const chargeKeyFor = (toolCallId = 'call-1') => `jingle:c1:${stableToolCallId(toolCallId)}`

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate-j', version: 1, schema: { per_call_micro: 4_000_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-4000000', expires_at: null }] }) })
  cutSignoff.mockResolvedValue({ audio: Buffer.from('cut'), seconds: 3.4 })
  mkdtempSync.mockImplementation(realMkdtempSync.fn)
  upload
    .mockResolvedValueOnce({ fileId: 'full-1', name: 'Jingle.mp3', type: 'audio/mpeg', size: 3 })
    .mockResolvedValueOnce({ fileId: 'cut-1', name: 'Jingle sign-off.m4a', type: 'audio/mp4', size: 3 })
})

describe('generate_jingle (J3)', () => {
  it('charges the Lyria 3 rate first, sings the lyrics then the line, and returns both files', async () => {
    const order: string[] = []
    spendCredits.mockImplementation(async () => { order.push('charge') })
    const gw = vi.fn(async () => { order.push('gateway'); return new Response(JSON.stringify({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: LYRICS }), { status: 200 }) })
    global.fetch = gw as unknown as typeof fetch

    const result = await generateJingle.execute!(input as never, ctx())

    expect(order).toEqual(['charge', 'gateway'])
    expect(resolveRate).toHaveBeenCalledWith('music_generation', JINGLE_MODEL)
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ amountMicro: -4_000_000n, kind: 'debit', key: chargeKeyFor(), jobType: 'music_generation' }))
    expect(JSON.parse((gw.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      model: 'lyria-3-clip-preview', prompt: 'bright pop, female vocal, 120 bpm', lyrics: ['Every bubble, every sip', 'Bubbli, feel the magic'],
    })
    expect(cutSignoff).toHaveBeenCalledWith(expect.stringMatching(/full\.mp3$/), { start: 22.1, end: 25, text: 'Bubbli, feel the magic' }, expect.any(String))
    expect(result).toEqual({
      fileId: 'full-1', name: 'Jingle.mp3', fileType: 'audio/mpeg', size: 3,
      signoffFileId: 'cut-1', signoffSeconds: 3.4,
      lines: [{ start: 0, end: 6.2, text: 'Every bubble, every sip' }, { start: 22.1, end: 25, text: 'Bubbli, feel the magic' }],
    })
    expect(upload.mock.calls[1][1]).toMatchObject({ contentType: 'audio/mp4', extension: 'm4a' })
  })

  it('adds the language to the prompt', async () => {
    const gw = gatewayOk()
    global.fetch = gw
    await generateJingle.execute!({ ...input, language: 'Hindi' } as never, ctx())
    expect(JSON.parse(((gw as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string).prompt).toBe('bright pop, female vocal, 120 bpm. Sung in Hindi.')
  })

  it('builds the charge key from a hashed tool-call id, never the raw one', async () => {
    global.fetch = gatewayOk()
    const huge = `gs.${'A'.repeat(6000)}.0`
    await generateJingle.execute!(input as never, ctx(huge))
    const key = spendCredits.mock.calls[0][0].key as string
    expect(key).toBe(chargeKeyFor(huge))
    expect(key.length).toBeLessThan(120)
  })

  it('never calls the gateway when credits are short', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('short'), { name: 'InsufficientCreditsError' }))
    expect(await generateJingle.execute!(input as never, ctx())).toEqual({ insufficientCredits: true })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses NO_SESSION_CONTEXT before charging', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const r = await generateJingle.execute!(input as never, ctx('call-1', { tenantId: 't1' }))
    expect(r).toMatchObject({ refused: true, refusalReason: 'NO_SESSION_CONTEXT' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('an unlimited tenant is never charged or refunded', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = gatewayOk({ refused: true, reason: 'CONTENT_BLOCKED' })
    await generateJingle.execute!(input as never, ctx())
    expect(spendCredits).not.toHaveBeenCalled()
  })
})

// Review Focus 5: every failure after the charge refunds it.
describe('generate_jingle refunds on every failure path', () => {
  const refunded = () => expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund', key: `${chargeKeyFor()}:refund`, amountMicro: 4_000_000n }))

  it.each([
    ['the gateway answers 503', () => { global.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch }, /^GENERATION_FAILED$/],
    ['the gateway call throws', () => { global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch }, /^GENERATION_FAILED$/],
    ['Lyria rejects the prompt (422)', () => { global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'try another style' } }), { status: 422 })) as unknown as typeof fetch }, /^PROMPT_REJECTED: try another style$/],
    ['the prompt is content-blocked', () => { global.fetch = gatewayOk({ refused: true, reason: 'CONTENT_BLOCKED' }) }, /^CONTENT_BLOCKED$/],
    ['no audio comes back', () => { global.fetch = gatewayOk({ mimeType: 'audio/mpeg', lyricsText: LYRICS }) }, /^GENERATION_FAILED$/],
    ['the line was not sung', () => { global.fetch = gatewayOk({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: '[0.0:6.2] Every bubble, every sip' }) }, /^JINGLE_LINE_NOT_SUNG: Lyria did not sing "Bubbli, feel the magic"; try once more or shorten the line$/],
    ['the cut fails', () => { global.fetch = gatewayOk(); cutSignoff.mockRejectedValue(new Error('ffmpeg died')) }, /^JINGLE_CUT_FAILED$/],
    ['mkdtempSync throws before the cut', () => { global.fetch = gatewayOk(); mkdtempSync.mockImplementation(() => { throw new Error('ENOSPC') }) }, /^JINGLE_CUT_FAILED$/],
    ['the full clip upload fails', () => { global.fetch = gatewayOk(); upload.mockReset(); upload.mockResolvedValueOnce(null) }, /^STORAGE_FAILED$/],
    ['the sign-off upload fails', () => { global.fetch = gatewayOk(); upload.mockReset(); upload.mockResolvedValueOnce({ fileId: 'full-1', name: 'J.mp3', type: 'audio/mpeg', size: 3 }).mockResolvedValueOnce(null) }, /^STORAGE_FAILED$/],
  ])('%s', async (_name, arrange, reason) => {
    arrange()
    const r = await generateJingle.execute!(input as never, ctx()) as { refused?: boolean; refusalReason?: string }
    expect(r.refused).toBe(true)
    expect(r.refusalReason).toMatch(reason)
    refunded()
  })
})
