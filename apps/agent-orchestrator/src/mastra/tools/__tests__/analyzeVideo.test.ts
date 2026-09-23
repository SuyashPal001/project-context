import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  downloadToSessionCache: vi.fn().mockResolvedValue({
    filePath: '/tmp/fake.mp4', buf: Buffer.from('fake-video'), mimeType: 'video/mp4',
  }),
}))
vi.mock('../../../media.js', () => ({
  extractVideoFrames: vi.fn().mockResolvedValue({
    frames: [{ filePath: '/tmp/f1.jpg', base64: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', name: 'clip_frame1.jpg', timestampSeconds: 0 }],
    durationSeconds: 8.0,
  }),
}))
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

import { analyzeVideoTool } from '../analyzeVideo.js'
import { extractVideoFrames } from '../../../media.js'

function ctx(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { idToken: 'token-1', tenantId: 'tenant-1', sessionId: 'session-1', ...overrides }
  return { requestContext: { get: (key: string) => base[key] } } as any
}

describe('analyzeVideoTool', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns no_active_session when idToken or sessionId is missing', async () => {
    const result = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx({ sessionId: undefined }))
    expect((result as any).success).toBe(false)
    expect((result as any).error).toBe('no_active_session')
  })

  it('samples 8 frames in quick mode and calls the gateway with a summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a cat walks across a table' } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
    }))
    const result = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect(result).toEqual({ success: true, summary: 'a cat walks across a table', frameCount: 1, durationSeconds: 8.0 })
    expect(vi.mocked(extractVideoFrames)).toHaveBeenCalledWith('/tmp/fake.mp4', 'f1', 'session-1', 8, expect.any(AbortSignal))
  })

  it('returns durationSeconds and labels frames with timestamps in the gateway prompt', async () => {
    vi.mocked(extractVideoFrames).mockResolvedValueOnce({
      frames: [
        { filePath: '/tmp/f1.jpg', base64: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', name: 'f1', timestampSeconds: 0 },
        { filePath: '/tmp/f2.jpg', base64: 'data:image/jpeg;base64,BBB', mimeType: 'image/jpeg', name: 'f2', timestampSeconds: 4.5 },
      ],
      durationSeconds: 9.0,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'A short clip.' } }] }),
    }))

    const result = await analyzeVideoTool.execute!({ fileId: 'v1', mode: 'quick' } as never, ctx())

    expect((result as { durationSeconds?: number }).durationSeconds).toBe(9.0)
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    const textBlocks = body.messages[0].content.filter((c: { type: string }) => c.type === 'text')
    expect(textBlocks.some((b: { text: string }) => b.text.includes('t=0.0s'))).toBe(true)
    expect(textBlocks.some((b: { text: string }) => b.text.includes('t=4.5s'))).toBe(true)
  })

  it('samples more frames in deep mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'summary' } }] }),
    }))
    await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'deep' } as any, ctx())
    expect(vi.mocked(extractVideoFrames)).toHaveBeenCalledWith('/tmp/fake.mp4', 'f1', 'session-1', 20, expect.any(AbortSignal))
  })

  it('returns a structured error when frame extraction produces nothing', async () => {
    vi.mocked(extractVideoFrames).mockResolvedValueOnce({ frames: [], durationSeconds: 0 })
    const result = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect((result as any).success).toBe(false)
    expect((result as any).error).toBe('no frames could be extracted')
  })
})
