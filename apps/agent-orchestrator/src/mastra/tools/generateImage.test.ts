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

import { generateImage } from './generateImage'
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
})

describe('generateImage tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -50_000n, kind: 'debit' }))
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3 })
    expect(result).not.toHaveProperty('imageBase64')
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
})
