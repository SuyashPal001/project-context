import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool, resolveSourceImage } = vi.hoisted(() => ({
  spendCredits: vi.fn(),
  resolveRate: vi.fn(),
  isUnlimited: vi.fn(),
  getPool: vi.fn(),
  resolveSourceImage: vi.fn(),
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
vi.mock('../../media.js', () => ({ resolveSourceImage }))

const { confirmGenerationOrDecline } = vi.hoisted(() => ({
  confirmGenerationOrDecline: vi.fn(),
}))
vi.mock('./confirmGeneration.js', () => ({ confirmGenerationOrDecline }))

import { editImage } from './editImage.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

const baseInput = { prompt: 'make it blue', sourceFileId: 'src1', sourceMimeType: 'image/png' }

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
  // history, not implementations like mockRejectedValue/mockReturnValue set
  // by an earlier test, so a later test in this file would otherwise
  // silently inherit e.g. the insufficientCredits test's rejected spendCredits.
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
  resolveSourceImage.mockResolvedValue({ base64: 'c291cmNlLWJ5dGVz', mimeType: 'image/png' })
  confirmGenerationOrDecline.mockResolvedValue({ confirmed: true })
})

describe('editImage tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -50_000n, kind: 'debit' }))
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body).toMatchObject({ prompt: 'make it blue', sourceImageBase64: 'c291cmNlLWJ5dGVz', sourceMimeType: 'image/png' })
    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
    expect(result).not.toHaveProperty('imageBase64')
  })

  it('includes creditsUsedMicro and model in the result when the generation was charged', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
  })

  it('omits creditsUsedMicro when the tenant is unlimited (never charged)', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3, model: 'gemini-3-pro-image-preview' })
    expect(result).not.toHaveProperty('creditsUsedMicro')
  })

  it('does not call the gateway result into a charge and returns a refusal when Gemini refuses — no charge, nothing to refund', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'SAFETY' }), { status: 200 })) as unknown as typeof fetch

    const result = await editImage.execute!(baseInput as never, baseCtx())

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

    const result = await editImage.execute!(baseInput as never, baseCtx())

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

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true })
  })

  it('returns GENERATION_FAILED without charging when a non-refused gateway response is missing imageBase64', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED' })
  })

  it('returns SOURCE_IMAGE_UNAVAILABLE without charging when resolveSourceImage returns null', async () => {
    resolveSourceImage.mockResolvedValue(null)
    global.fetch = vi.fn()

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(global.fetch).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' })
  })

  it('returns SOURCE_IMAGE_TOO_LARGE without calling the gateway when the source exceeds the byte cap', async () => {
    // Base64 string decoding to > 20MB of raw bytes.
    const hugeBase64 = 'A'.repeat(28 * 1024 * 1024)
    resolveSourceImage.mockResolvedValue({ base64: hugeBase64, mimeType: 'image/png' })
    global.fetch = vi.fn()

    const result = await editImage.execute!(baseInput as never, baseCtx())

    expect(global.fetch).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' })
  })

  it('short-circuits with DECLINED and never resolves the source image when the user declines', async () => {
    confirmGenerationOrDecline.mockResolvedValue({ confirmed: false })
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await editImage.execute!({ prompt: 'make it blue', sourceFileId: 'f1', sourceMimeType: 'image/png' } as never, baseCtx())

    expect(resolveSourceImage).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'DECLINED' })
  })
})
