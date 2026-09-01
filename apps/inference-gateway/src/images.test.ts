import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
  geminiBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
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

import { classifyGeminiImageResponse, generateImage } from './images'
import { vertexBreaker, geminiBreaker } from './router.js'

describe('classifyGeminiImageResponse', () => {
  it('extracts inline image bytes from a normal candidate', () => {
    const geminiResponse = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
      }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      imageBase64: 'QUJD',
      mimeType: 'image/png',
    })
  })

  it('classifies a SAFETY finishReason as a refusal, not a throw', () => {
    const geminiResponse = {
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      refused: true,
      reason: 'SAFETY',
    })
  })

  it('classifies an empty candidate list as a refusal', () => {
    expect(classifyGeminiImageResponse({ candidates: [] })).toEqual({
      refused: true,
      reason: 'NO_CANDIDATES',
    })
  })
})

describe('generateImage — no-Ollama-fallback invariant', () => {
  const req = { model: 'gemini-3-pro-image-preview', prompt: 'a cat' }
  const okBody = {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
    }],
  }
  const origGeminiKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexBreaker.isAvailable).mockReturnValue(true)
    vi.mocked(geminiBreaker.isAvailable).mockReturnValue(true)
    process.env.GEMINI_API_KEY = 'test-gemini-key'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (origGeminiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origGeminiKey
  })

  it('vertex success → no gemini call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com')
    expect(vertexBreaker.onSuccess).toHaveBeenCalledTimes(1)
    expect(geminiBreaker.onSuccess).not.toHaveBeenCalled()
    expect(geminiBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('vertex failure + gemini success → falls back correctly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'vertex boom' })
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com')
    expect(fetchMock.mock.calls[1][0]).toContain('generativelanguage.googleapis.com')
    expect(vertexBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(geminiBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('vertex circuit open → skips straight to gemini', async () => {
    vi.mocked(vertexBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com')
    // Circuit was already open — never attempted, so no failure to record.
    expect(vertexBreaker.onFailure).not.toHaveBeenCalled()
    expect(geminiBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('both vertex and gemini fail → throws cleanly with both reasons, no further fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'vertex boom' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'gemini boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try {
      await generateImage(req)
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(caught!.message).toMatch(/gemini boom/i)
    // Exactly the two calls (vertex, gemini) — no third ("ollama" or
    // otherwise) fallback call was ever made.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vertexBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(geminiBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('no GEMINI_API_KEY configured after vertex failure → throws cleanly, never calls gemini', async () => {
    delete process.env.GEMINI_API_KEY
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try {
      await generateImage(req)
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(caught!.message).toMatch(/GEMINI_API_KEY/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(geminiBreaker.onFailure).not.toHaveBeenCalled()
    expect(geminiBreaker.onSuccess).not.toHaveBeenCalled()
  })
})
