import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexImageBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
  geminiImageBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
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

import { classifyGeminiImageResponse, generateImage, buildGeminiImageRequest } from './images'
import { vertexImageBreaker, geminiImageBreaker } from './router.js'

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
    vi.mocked(vertexImageBreaker.isAvailable).mockReturnValue(true)
    vi.mocked(geminiImageBreaker.isAvailable).mockReturnValue(true)
    process.env.GEMINI_API_KEY = 'test-gemini-key'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (origGeminiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origGeminiKey
  })

  it('gemini success → no vertex call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com')
    expect(geminiImageBreaker.onSuccess).toHaveBeenCalledTimes(1)
    expect(vertexImageBreaker.onSuccess).not.toHaveBeenCalled()
    expect(vertexImageBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('gemini failure + vertex success → falls back correctly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'gemini boom' })
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com')
    expect(fetchMock.mock.calls[1][0]).toContain('aiplatform.googleapis.com')
    expect(geminiImageBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(vertexImageBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('gemini circuit open → skips straight to vertex', async () => {
    vi.mocked(geminiImageBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com')
    // Circuit was already open — never attempted, so no failure to record.
    expect(geminiImageBreaker.onFailure).not.toHaveBeenCalled()
    expect(vertexImageBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('both gemini and vertex fail → throws cleanly with both reasons, no further fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'gemini boom' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try {
      await generateImage(req)
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/gemini boom/i)
    expect(caught!.message).toMatch(/vertex boom/i)
    // Exactly the two calls (gemini, vertex) — no third ("ollama" or
    // otherwise) fallback call was ever made.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(geminiImageBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(vertexImageBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('no GEMINI_API_KEY configured → skips straight to vertex', async () => {
    delete process.env.GEMINI_API_KEY
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateImage(req)

    expect(result).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com')
    expect(vertexImageBreaker.onSuccess).toHaveBeenCalledTimes(1)
    expect(geminiImageBreaker.onFailure).not.toHaveBeenCalled()
    expect(geminiImageBreaker.onSuccess).not.toHaveBeenCalled()
  })
})

describe('buildGeminiImageRequest', () => {
  it('includes one inline image part per entry in sourceImages, in order', () => {
    const req = {
      model: 'gemini-3-pro-image-preview',
      prompt: 'a cast sheet',
      sourceImages: [
        { base64: 'AAAA', mimeType: 'image/png' },
        { base64: 'BBBB', mimeType: 'image/jpeg' },
      ],
    }
    const body = buildGeminiImageRequest(req)
    const parts = body.contents[0].parts
    expect(parts[0]).toEqual({ text: 'a cast sheet' })
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } })
    expect(parts[2]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } })
    expect(parts).toHaveLength(3)
  })

  it('still supports the single sourceImageBase64/sourceMimeType shape edit_image sends', () => {
    const req = {
      model: 'gemini-3-pro-image-preview',
      prompt: 'edit this',
      sourceImageBase64: 'CCCC',
      sourceMimeType: 'image/png',
    }
    const body = buildGeminiImageRequest(req)
    expect(body.contents[0].parts).toEqual([
      { text: 'edit this' },
      { inlineData: { mimeType: 'image/png', data: 'CCCC' } },
    ])
  })

  it('with no source image at all, sends only the text part', () => {
    const req = { model: 'gemini-3-pro-image-preview', prompt: 'a plain image' }
    const body = buildGeminiImageRequest(req)
    expect(body.contents[0].parts).toEqual([{ text: 'a plain image' }])
  })
})
