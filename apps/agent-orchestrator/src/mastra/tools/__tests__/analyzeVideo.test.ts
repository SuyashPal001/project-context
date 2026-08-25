import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  downloadToSessionCache: vi.fn().mockResolvedValue({
    filePath: '/tmp/fake.mp4', buf: Buffer.from('fake-video'), mimeType: 'video/mp4',
  }),
}))
vi.mock('../../../media.js', () => ({
  extractVideoFrames: vi.fn().mockResolvedValue([
    { filePath: '/tmp/f1.jpg', base64: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', name: 'clip_frame1.jpg' },
  ]),
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
    expect(result).toEqual({ success: true, summary: 'a cat walks across a table', frameCount: 1 })
    expect(vi.mocked(extractVideoFrames)).toHaveBeenCalledWith('/tmp/fake.mp4', 'f1', 'session-1', 8)
  })

  it('samples more frames in deep mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'summary' } }] }),
    }))
    await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'deep' } as any, ctx())
    expect(vi.mocked(extractVideoFrames)).toHaveBeenCalledWith('/tmp/fake.mp4', 'f1', 'session-1', 20)
  })

  it('returns a structured error when frame extraction produces nothing', async () => {
    vi.mocked(extractVideoFrames).mockResolvedValueOnce([])
    const result = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect((result as any).success).toBe(false)
    expect((result as any).error).toBe('no frames could be extracted')
  })
})
