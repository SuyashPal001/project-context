import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexMusicBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
}))

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuth() {
    return {
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({ token: 'fake-token' }),
      }),
    }
  }),
}))

import { classifyVertexMusicResponse, generateMusic } from './music'
import { vertexMusicBreaker } from './router.js'

describe('classifyVertexMusicResponse', () => {
  it('extracts base64 audio bytes from a normal predict response', () => {
    const predictResponse = {
      predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }],
    }
    expect(classifyVertexMusicResponse(predictResponse)).toEqual({
      audioBase64: 'QUJD',
      mimeType: 'audio/wav',
    })
  })

  it('classifies an empty predictions list as a refusal', () => {
    expect(classifyVertexMusicResponse({ predictions: [] })).toEqual({
      refused: true,
      reason: 'NO_PREDICTIONS',
    })
  })

  it('classifies a missing bytesBase64Encoded field as a refusal', () => {
    expect(classifyVertexMusicResponse({ predictions: [{ mimeType: 'audio/wav' }] })).toEqual({
      refused: true,
      reason: 'NO_AUDIO_BYTES',
    })
  })
})

describe('generateMusic — single-path invariant (no fallback)', () => {
  const req = { model: 'lyria-002', prompt: 'a calm lo-fi beat' }
  const okBody = { predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }] }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vertex success → returns audio bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateMusic(req)

    expect(result).toEqual({ audioBase64: 'QUJD', mimeType: 'audio/wav' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('lyria-002:predict')
    expect(vertexMusicBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('vertex failure → throws cleanly, no fallback attempted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vertexMusicBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('vertex circuit open → throws cleanly without attempting a call', async () => {
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/circuit open/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a model not on the allowlist before making any call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic({ model: 'lyria-3-pro-preview', prompt: 'x' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Unsupported music model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
