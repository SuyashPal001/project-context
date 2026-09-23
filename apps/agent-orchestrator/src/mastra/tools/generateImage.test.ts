import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(),
  resolveRate: vi.fn(),
  isUnlimited: vi.fn(),
  getPool: vi.fn(),
}))
// costMicro is a pure flat-rate calculation (see packages/foundation/credits/src/rate.ts);
// mocked here with equivalent math rather than pulled in via importOriginal, which would
// drag in the real @serverless-saas/database import chain for a DB-free unit test.
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number; per_message_micro?: number; per_run_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? schema.per_message_micro ?? schema.per_run_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

const { resolveSourceImage } = vi.hoisted(() => ({ resolveSourceImage: vi.fn() }))
vi.mock('../../media.js', () => ({ resolveSourceImage }))

const { shouldRequireApproval } = vi.hoisted(() => ({
  shouldRequireApproval: vi.fn(),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

const { refundStaleBackgroundTask } = vi.hoisted(() => ({ refundStaleBackgroundTask: vi.fn() }))
vi.mock('./backgroundTaskRefund.js', () => ({ refundStaleBackgroundTask }))

import { generateImage } from './generateImage.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
  // history, not implementations like mockRejectedValue/mockReturnValue set
  // by an earlier test, so a later test in this file would otherwise
  // silently inherit e.g. the insufficientCredits test's rejected spendCredits.
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateImage tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -50_000n, kind: 'debit' }))
    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
    expect(result).not.toHaveProperty('imageBase64')
  })

  it('includes creditsUsedMicro and model in the result when the generation was charged', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
  })

  it('omits creditsUsedMicro when the tenant is unlimited (never charged)', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3, model: 'gemini-3-pro-image-preview' })
    expect(result).not.toHaveProperty('creditsUsedMicro')
  })

  it('requireApproval delegates to shouldRequireApproval with image_generation/IMAGE_MODEL', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctxArg = baseCtx()

    await (generateImage.requireApproval as (input: unknown, ctx: unknown) => Promise<boolean>)({ prompt: 'a cat' }, ctxArg)

    expect(shouldRequireApproval).toHaveBeenCalledWith(
      { resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview' },
      ctxArg,
    )
  })

  it('does not call the gateway result into a charge and returns a refusal when Gemini refuses — no charge, nothing to refund', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'SAFETY' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'SAFETY' })
  })

  it('refunds with the original grants\' shortest expiry when the post-charge upload fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({
      rows: [{ amount_micro: '-50000', expires_at: '2026-12-01T00:00:00.000Z' }],
    })
    getPool.mockReturnValue({ query })

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 50_000n, kind: 'refund', grantType: 'refund',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('returns insufficientCredits when spendCredits throws after a successful generation', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true })
  })

  it('returns GENERATION_FAILED without charging when a non-refused gateway response is missing imageBase64', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED' })
  })

  it('refunds with the shortest expiry across multiple grants the debit drew from', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({
      rows: [
        { amount_micro: '-30000', expires_at: '2027-01-01T00:00:00.000Z' },
        { amount_micro: '-20000', expires_at: '2026-12-01T00:00:00.000Z' },
      ],
    })
    getPool.mockReturnValue({ query })

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 50_000n, kind: 'refund', grantType: 'refund',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('refunds with a null (permanent) expiry only when every drawn grant was permanent', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({
      rows: [{ amount_micro: '-50000', expires_at: null }],
    })
    getPool.mockReturnValue({ query })

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 50_000n, kind: 'refund', grantType: 'refund', expiresAt: null,
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('refuses before any charge when the prompt is missing the identityAnchor terseTag', async () => {
    const result = await generateImage.execute!(
      {
        prompt: 'A woman making coffee, wearing a cardigan.', // missing the exact terseTag string
        identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light' },
      } as never,
      baseCtx(),
    )
    expect(result).toEqual({ refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('refuses before any charge when the prompt is missing the identityAnchor styleLock', async () => {
    const result = await generateImage.execute!(
      {
        prompt: 'the woman in the yellow cardigan making coffee', // missing styleLock text
        identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light, 35mm lens' },
      } as never,
      baseCtx(),
    )
    expect(result).toEqual({ refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
  })

  it('resolves referenceFileIds and sends them as sourceImages when both identityAnchor strings are present', async () => {
    resolveSourceImage.mockResolvedValue({ base64: 'AAAA', mimeType: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'ZZZZ', mimeType: 'image/png' }), { status: 200 })) as unknown as ReturnType<typeof vi.fn>
    global.fetch = fetchMock as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 10 })

    const result = await generateImage.execute!(
      {
        prompt: 'the woman in the yellow cardigan making coffee, warm morning light, 35mm lens',
        referenceFileIds: ['11111111-1111-1111-1111-111111111111'],
        identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light, 35mm lens' },
      } as never,
      baseCtx(),
    )
    expect(resolveSourceImage).toHaveBeenCalledWith('tok', '11111111-1111-1111-1111-111111111111', 'image/png', 'c1')
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sentBody.sourceImages).toEqual([{ base64: 'AAAA', mimeType: 'image/png' }])
    expect((result as { fileId?: string }).fileId).toBe('f1')
  })

  // Regression test mirroring generateVideo.test.ts's existing "actorId:
  // undefined" test (~line 330) for the identical class of bug: agentId must
  // stay undefined, not '', or spendCredits' actorId hits Postgres as
  // ''::uuid and throws before any charge. This guards Step 3's agentId fix
  // above from being silently reverted later.
  it('passes agentId as undefined (not empty string) to spendCredits when requestContext has no agentId set', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    await generateImage.execute!(
      { prompt: 'a red bicycle' } as never,
      ctx({ tenantId: 't1', conversationId: 'c1', idToken: 'tok' }), // no agentId key set
    )

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ actorId: undefined }))
  })

  it('builds a deterministic chargeKey from conversationId and toolCallId, not a random uuid', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const execCtx = { requestContext: (baseCtx() as unknown as { requestContext: RequestContext }).requestContext, agent: { toolCallId: 'tc-1' } } as never
    await generateImage.execute!({ prompt: 'a red bicycle' } as never, execCtx)

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'image:c1:tc-1:0' }))
  })

  it('is registered for background dispatch with a timeout above the gateway ceiling and no retries', () => {
    expect(generateImage.background).toEqual(expect.objectContaining({
      enabled: true,
      timeoutMs: 100_000,
      maxRetries: 0,
    }))
  })

  it('wires onFailed to the shared refund backstop for kind "image"', async () => {
    const task = { id: 't1', resourceId: 'tenant-1', threadId: 'conv-1', toolCallId: 'tc-1' } as never
    await generateImage.background!.onFailed!(task)
    expect(vi.mocked(refundStaleBackgroundTask)).toHaveBeenCalledWith(task, 'image')
  })
})
