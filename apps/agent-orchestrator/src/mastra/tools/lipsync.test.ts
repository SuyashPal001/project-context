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
const { fetchPresignedUrl } = vi.hoisted(() => ({ fetchPresignedUrl: vi.fn() }))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

import { lipsync } from './lipsync.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 250_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
})

describe('lipsync tool', () => {
  it('resolves both file ids to URIs, charges before the gateway call, and returns the synced clip', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f2', name: 'synced.mp4', type: 'video/mp4', size: 3 })

    const result = await lipsync.execute!({ videoFileId: 'v1', audioFileId: 'a1' } as never, baseCtx())

    expect(fetchPresignedUrl).toHaveBeenCalledWith('v1', 'tok')
    expect(fetchPresignedUrl).toHaveBeenCalledWith('a1', 'tok')
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'lipsync_generation' }))
    expect(result).toMatchObject({ fileId: 'f2' })
  })

  it('defaults model to fal-ai/latentsync when not specified', async () => {
    let sentBody: Record<string, unknown> = {}
    global.fetch = vi.fn(async (_url, opts: RequestInit) => {
      sentBody = JSON.parse(opts.body as string)
      return new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f2', name: 'synced.mp4', type: 'video/mp4', size: 3 })

    await lipsync.execute!({ videoFileId: 'v1', audioFileId: 'a1' } as never, baseCtx())
    expect(sentBody.model).toBe('fal-ai/latentsync')
  })

  it('refuses with SOURCE_UNAVAILABLE if a file id cannot be resolved, before any charge', async () => {
    fetchPresignedUrl.mockRejectedValueOnce(new Error('not found'))

    const result = await lipsync.execute!({ videoFileId: 'missing', audioFileId: 'a1' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })
})
