import { describe, it, expect, vi, beforeEach } from 'vitest'

// analyze_video now watches the WHOLE video plus audio (spec 2026-10-14 §4);
// the old frame-sampling tests were replaced, not deleted silently.
const ask = vi.fn()
vi.mock('../videoBreakdown/geminiVideo.js', () => ({ askGeminiVideo: (...a: unknown[]) => ask(...a) }))
vi.mock('../mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  downloadToSessionCache: vi.fn().mockResolvedValue({ filePath: '/tmp/fake.mp4', buf: Buffer.from('fake-video'), mimeType: 'video/mp4' }),
}))
vi.mock('node:child_process', () => ({
  execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '12.5\n', stderr: '' }),
}))
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

import { analyzeVideoTool } from '../analyzeVideo.js'

function ctx(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { idToken: 'token-1', tenantId: 'tenant-1', sessionId: 'session-1', ...overrides }
  return { requestContext: { get: (key: string) => base[key] } } as any
}

describe('analyzeVideoTool', () => {
  beforeEach(() => { ask.mockReset(); ask.mockResolvedValue({ raw: 'A woman lies on a rug.', usage: { prompt_tokens: 1, completion_tokens: 1 } }) })

  it('returns no_active_session when idToken or sessionId is missing', async () => {
    const result = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx({ sessionId: undefined }))
    expect((result as any).success).toBe(false)
    expect((result as any).error).toBe('no_active_session')
  })

  it('sends the whole video (not frames) and keeps its output shape', async () => {
    const r = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'deep' } as any, ctx())
    expect(r).toMatchObject({ success: true, summary: 'A woman lies on a rug.', durationSeconds: 12.5 })
    expect(ask.mock.calls[0][0]).toMatchObject({ video: { filePath: '/tmp/fake.mp4' }, durationS: 12.5, tenantId: 'tenant-1' })
  })

  it('asks for timestamped beats only in deep mode', async () => {
    await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'deep' } as any, ctx())
    expect(ask.mock.calls[0][0].prompt).not.toMatch(/timestamp range/)
    expect(ask.mock.calls[1][0].prompt).toMatch(/timestamp range/)
  })

  it('returns a structured error when the watch call fails', async () => {
    ask.mockRejectedValueOnce(new Error('gateway 502'))
    const r = await analyzeVideoTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect(r).toMatchObject({ success: false, error: 'gateway 502' })
  })
})
