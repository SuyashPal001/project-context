import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@serverless-saas/credits', () => ({
  isUnlimited: vi.fn(async () => false),
  resolveRate: vi.fn(async () => ({ id: 'r1', version: 1, schema: { per_call_micro: 80_000_000 } })),
  costMicro: vi.fn(() => 80_000_000n),
  spendCredits: vi.fn(async () => undefined),
}))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async (id: string) => `https://s3/${id}`) }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async () => ({ fileId: 'clip-1', name: 'c.mp4', type: 'video/mp4', size: 3 })) }))
vi.mock('./videoCredits.js', () => ({ refundVideoCharge: vi.fn(async () => undefined) }))

const { generateVeoClipItem, VEO_CLIP_MODEL } = await import('./veoClip.js')
const credits = await import('@serverless-saas/credits')
const { refundVideoCharge } = await import('./videoCredits.js')

const rc = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ tenantId: 't1', conversationId: 'c1', idToken: 'tok', ...o } as Record<string, string>)[k] })
const exec = { requestContext: rc(), agent: { toolCallId: 'remake:run1' } }
const input = { prompt: 'P', startImageFileId: 's1', endImageFileId: 'e1', durationSeconds: 6 as const, aspectRatio: '9:16' as const, title: 'Remake look 1 clip' }

beforeEach(() => vi.clearAllMocks())

describe('generateVeoClipItem', () => {
  it('charges first under a per-item key, sends both stills to the Veo model, uploads the clip', async () => {
    const fetchMock = vi.fn(async () => Response.json({ videoBase64: Buffer.from('mp4').toString('base64'), mimeType: 'video/mp4' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await generateVeoClipItem(input, exec, 7)
    expect(r).toMatchObject({ fileId: 'clip-1', creditsUsedMicro: '80000000' })
    expect(credits.resolveRate).toHaveBeenCalledWith('video_generation', VEO_CLIP_MODEL)
    const spend = vi.mocked(credits.spendCredits).mock.calls[0][0] as { key: string }
    expect(spend.key).toMatch(/^veo:c1:[0-9a-f]{64}:7$/)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))
    expect(body).toMatchObject({ model: 'veo-3.1-fast-generate-001', task: 'image_to_video', imageUri: 'https://s3/s1', lastFrameUri: 'https://s3/e1', durationSeconds: 6, aspectRatio: '9:16' })
  })
  it('refunds and reports a content block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ refused: true, reason: 'CONTENT_BLOCKED' })))
    const r = await generateVeoClipItem(input, exec, 0)
    expect(r).toMatchObject({ refused: true, refusalReason: 'CONTENT_BLOCKED' })
    expect(refundVideoCharge).toHaveBeenCalled()
  })
  it('refunds when the gateway fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
    const r = await generateVeoClipItem(input, exec, 0)
    expect(r).toMatchObject({ refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(refundVideoCharge).toHaveBeenCalled()
  })
  it('says insufficient credits without calling the model', async () => {
    vi.mocked(credits.spendCredits).mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'InsufficientCreditsError' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await generateVeoClipItem(input, exec, 0)).toEqual({ insufficientCredits: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
