import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  downloadToSessionCache: vi.fn().mockResolvedValue({
    filePath: '/tmp/fake', buf: Buffer.from('fake-audio'), mimeType: 'audio/mpeg',
  }),
}))
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

import { analyzeAudioTool } from '../analyzeAudio.js'

function ctx(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { idToken: 'token-1', tenantId: 'tenant-1', sessionId: 'session-1', ...overrides }
  return { requestContext: { get: (key: string) => base[key] } } as any
}

describe('analyzeAudioTool', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns no_active_session when idToken or sessionId is missing', async () => {
    const result = await analyzeAudioTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx({ idToken: undefined }))
    expect((result as any).success).toBe(false)
    expect((result as any).error).toBe('no_active_session')
  })

  it('returns a transcript on a successful gateway call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello world' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    }))
    const result = await analyzeAudioTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect(result).toEqual({ success: true, transcript: 'hello world' })
  })

  it('returns a structured error, not a throw, when the gateway call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const result = await analyzeAudioTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    expect((result as any).success).toBe(false)
    expect((result as any).error).toContain('500')
  })

  it('returns a partial timeout error when the gateway call is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: { signal: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    )))
    vi.useFakeTimers()
    const resultPromise = analyzeAudioTool.execute!({ fileId: 'f1', mode: 'quick' } as any, ctx())
    await vi.advanceTimersByTimeAsync(46_000)
    const result = await resultPromise
    expect((result as any).success).toBe(false)
    expect((result as any).partial).toBe(true)
    vi.useRealTimers()
  })
})
