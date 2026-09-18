import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(),
  resolveRate: vi.fn(),
  isUnlimited: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

const { shouldRequireApproval } = vi.hoisted(() => ({
  shouldRequireApproval: vi.fn(),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

import { generateVideo } from './generateVideo.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 100_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateVideo tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'clip.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'a marble rolling down a track', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -100_000n, kind: 'debit', jobType: 'video_generation' }))
    expect(result).toEqual({
      fileId: 'f1', name: 'clip.mp4', fileType: 'video/mp4', size: 3,
      creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash', jobId: expect.any(String),
    })
    expect(result).not.toHaveProperty('videoBase64')
  })

  it('includes creditsUsedMicro and model in the result when the generation was charged', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'a car driving', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(result).toEqual({
      fileId: 'f1', name: 'x.mp4', fileType: 'video/mp4', size: 3,
      creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash', jobId: expect.any(String),
    })
  })

  it('omits creditsUsedMicro when the tenant is unlimited (never charged)', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'a car driving', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ fileId: 'f1', name: 'x.mp4', fileType: 'video/mp4', size: 3, model: 'google/gemini-omni-1.1-flash', jobId: expect.any(String) })
    expect(result).not.toHaveProperty('creditsUsedMicro')
  })

  // NOTE: under charge-before-call ordering, charging happens BEFORE the
  // gateway is ever called, so a refusal returned by the gateway is
  // discovered only *after* the charge has already gone through — the same
  // reasoning the brief spells out for the "missing videoBase64" test below.
  // This test therefore now asserts a charge-then-refund pair rather than
  // "no charge at all", which was only true under the old post-charge
  // ordering. Flagged in the task report as a deliberate deviation from the
  // brief's one-line description of this test ("still valid, only needs
  // mode/aspectRatio/durationSeconds added") because that description
  // predates accounting for charge-before-call on this exact branch.
  it('refunds when the gateway refuses (charge-before-call means the charge already happened)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'NO_VIDEO_CONTENT' }), { status: 200 })) as unknown as typeof fetch
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'anything', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 100_000n, kind: 'refund', grantType: 'refund', jobType: 'video_generation',
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'NO_VIDEO_CONTENT', jobId: expect.any(String) })
  })

  it('refunds when the post-charge upload fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'anything', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 100_000n, kind: 'refund', grantType: 'refund', jobType: 'video_generation',
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED', jobId: expect.any(String) })
  })

  it('returns insufficientCredits when spendCredits throws after a successful generation', async () => {
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'anything', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true, jobId: expect.any(String) })
  })

  it('returns GENERATION_FAILED without charging when a non-refused gateway response is missing videoBase64', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'anything', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 100_000n, kind: 'refund', grantType: 'refund', jobType: 'video_generation',
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED', jobId: expect.any(String) })
  })

  it('requireApproval delegates to shouldRequireApproval with video_generation/VIDEO_MODEL', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctxArg = baseCtx()

    await (generateVideo.requireApproval as (input: unknown, ctx: unknown) => Promise<boolean>)({ prompt: 'a marble rolling down a track' }, ctxArg)

    expect(shouldRequireApproval).toHaveBeenCalledWith(
      { resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash' },
      ctxArg,
    )
  })

  it('mints a distinct chargeKey per toolCallId, so a second video in the same conversation is not free', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ videoBase64: 'QUJD', mimeType: 'video/mp4' }) }))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const ctxA = { requestContext: (baseCtx() as unknown as { requestContext: RequestContext }).requestContext, agent: { toolCallId: 'call-1' } } as never
    const ctxB = { requestContext: (baseCtx() as unknown as { requestContext: RequestContext }).requestContext, agent: { toolCallId: 'call-2' } } as never
    await generateVideo.execute!({ mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never, ctxA)
    await generateVideo.execute!({ mode: 'text_to_video', prompt: 'y', aspectRatio: '16:9', durationSeconds: 8 } as never, ctxB)

    const chargeKeys = spendCredits.mock.calls.map((call: unknown[]) => (call[0] as { key: string }).key)
    expect(new Set(chargeKeys).size).toBe(2)
  })

  it('rejects animate_frame without startImageFileId', async () => {
    const result = await generateVideo.execute!(
      { mode: 'animate_frame', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(result).toMatchObject({ error: true })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('refuses SOURCE_IMAGE_UNAVAILABLE for animate_frame when idToken is missing, without charging or calling the gateway', async () => {
    const ctxNoIdToken = ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1' })
    global.fetch = vi.fn() as unknown as typeof fetch

    const result = await generateVideo.execute!(
      { mode: 'animate_frame', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8, startImageFileId: 'img1' } as never,
      ctxNoIdToken,
    )

    expect(result).toEqual({ refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId: expect.any(String) })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('resolves startImageFileId to a presigned URL and forwards it as imageUri', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('presigned-url')) {
        return new Response(JSON.stringify({ presignedUrl: 'https://s3.example.com/product.jpg' }), { status: 200 })
      }
      return new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    })
    global.fetch = fetchSpy as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    await generateVideo.execute!(
      { mode: 'animate_frame', prompt: 'x', aspectRatio: '9:16', durationSeconds: 6, startImageFileId: 'img1' } as never,
      baseCtx(),
    )

    const genCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/v1/video/generations')) as unknown as [string, RequestInit]
    const body = JSON.parse(genCall[1].body as string)
    expect(body.imageUri).toBe('https://s3.example.com/product.jpg')
    expect(body.task).toBe('image_to_video')
  })

  it('charges credits before calling the gateway, refunding on a post-charge failure', async () => {
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })
    const callOrder: string[] = []
    spendCredits.mockImplementation(async () => { callOrder.push('charge') })
    const originalFetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 }))
    global.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => { callOrder.push('gateway'); return originalFetch(...(args as unknown as [])) }) as unknown as typeof fetch

    await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    )

    expect(callOrder[0]).toBe('charge')
  })

  it('refuses when the prompt contains a quoted line that does not match approvedDialogue', async () => {
    const result = await generateVideo.execute!(
      {
        mode: 'text_to_video',
        prompt: 'A creator speaking to camera, saying "Try our new serum today."',
        aspectRatio: '16:9', durationSeconds: 8,
        approvedDialogue: 'Try our NEW serum today!',
      } as never,
      baseCtx(),
    )
    expect(result).toEqual({ refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED', jobId: expect.any(String) })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses when the prompt has two quoted spans and only one matches approvedDialogue', async () => {
    const result = await generateVideo.execute!(
      {
        mode: 'text_to_video',
        prompt: 'A creator says "Try our new serum today." while a sign reads "50% off this week."',
        aspectRatio: '16:9', durationSeconds: 8,
        approvedDialogue: 'Try our new serum today.',
      } as never,
      baseCtx(),
    )
    expect(result).toEqual({ refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED', jobId: expect.any(String) })
  })

  it('refuses when the prompt contains a curly/smart-quoted line that does not match approvedDialogue', async () => {
    const result = await generateVideo.execute!(
      {
        mode: 'text_to_video',
        prompt: 'A creator speaking to camera, saying “Try our new serum today.”',
        aspectRatio: '16:9', durationSeconds: 8,
        approvedDialogue: 'Try our NEW serum today!',
      } as never,
      baseCtx(),
    )
    expect(result).toEqual({ refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED', jobId: expect.any(String) })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('proceeds when the quoted line exactly matches approvedDialogue', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      {
        mode: 'text_to_video',
        prompt: 'A creator speaking to camera, saying "Try our new serum today."',
        aspectRatio: '16:9', durationSeconds: 8,
        approvedDialogue: 'Try our new serum today.',
      } as never,
      baseCtx(),
    ) as { refused?: boolean }
    expect(result.refused).toBeUndefined()
  })

  it('proceeds without approvedDialogue when the prompt has no quoted line', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'A calm sunrise over mountains, no dialogue.', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    ) as { refused?: boolean }
    expect(result.refused).toBeUndefined()
  })

  it('uses a namespaced model id for the rate lookup and result', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never,
      baseCtx(),
    ) as { model?: string }

    expect(resolveRate).toHaveBeenCalledWith('video_generation', 'google/gemini-omni-1.1-flash')
    expect(result.model).toBe('google/gemini-omni-1.1-flash')
  })
})
