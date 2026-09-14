import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  geminiVideoBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
  vertexVideoBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
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

import { classifyInteractionsVideoResponse, generateVideo } from './video'
import { geminiVideoBreaker, vertexVideoBreaker } from './router.js'

describe('classifyInteractionsVideoResponse', () => {
  it('extracts base64 video bytes from a normal interactions response', () => {
    const interactionResponse = {
      steps: [
        {
          content: [
            { type: 'text', text: 'here you go' },
            { type: 'video', data: 'QUJD', mime_type: 'video/mp4' },
          ],
        },
      ],
    }
    expect(classifyInteractionsVideoResponse(interactionResponse)).toEqual({
      videoBase64: 'QUJD',
      mimeType: 'video/mp4',
    })
  })

  it('classifies an empty steps list as a refusal', () => {
    expect(classifyInteractionsVideoResponse({ steps: [] })).toEqual({
      refused: true,
      reason: 'NO_STEPS',
    })
  })

  it('classifies missing video content as a refusal', () => {
    const interactionResponse = {
      steps: [{ content: [{ type: 'text', text: 'no video here' }] }],
    }
    expect(classifyInteractionsVideoResponse(interactionResponse)).toEqual({
      refused: true,
      reason: 'NO_VIDEO_CONTENT',
    })
  })

  it('finds the video block when it lands in a later step, not steps[0]', () => {
    const interactionResponse = {
      steps: [
        { content: [{ type: 'text', text: 'thinking...' }] },
        { content: [{ type: 'video', data: 'ZGVm', mime_type: 'video/mp4' }] },
      ],
    }
    expect(classifyInteractionsVideoResponse(interactionResponse)).toEqual({
      videoBase64: 'ZGVm',
      mimeType: 'video/mp4',
    })
  })
})

describe('generateVideo — Gemini API first, Vertex Veo fallback', () => {
  const req: { model: string; prompt: string; task: 'text_to_video' } = {
    model: 'gemini-omni-1.1-flash',
    prompt: 'a calm sunrise over mountains',
    task: 'text_to_video',
  }
  const okBody = {
    steps: [{ content: [{ type: 'video', data: 'QUJD', mime_type: 'video/mp4' }] }],
  }
  const originalKey = process.env.GEMINI_API_KEY
  const originalProject = process.env.VERTEX_PROJECT

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
    process.env.GEMINI_API_KEY = 'fake-api-key'
    process.env.VERTEX_PROJECT = 'fake-project'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
    if (originalProject === undefined) delete process.env.VERTEX_PROJECT
    else process.env.VERTEX_PROJECT = originalProject
  })

  it('gemini API key success → no Vertex call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo(req)

    expect(result).toEqual({ videoBase64: 'QUJD', mimeType: 'video/mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com/v1beta/interactions')
    expect(fetchMock.mock.calls[0][0]).not.toContain('aiplatform.googleapis.com')
    expect(geminiVideoBreaker.onSuccess).toHaveBeenCalledTimes(1)
    expect(vertexVideoBreaker.onSuccess).not.toHaveBeenCalled()
  })

  it('rejects a model not on the allowlist before making any call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo({ ...req, model: 'veo-3' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Unsupported video model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no GEMINI_API_KEY → skips straight to Vertex Veo', async () => {
    delete process.env.GEMINI_API_KEY
    // First fetch = Veo predictLongRunning (returns operation name).
    // Second fetch = Veo poll (returns done with inline video).
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/veo-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true, response: { videos: [{ bytesBase64Encoded: 'QUJD', mimeType: 'video/mp4' }] } }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo(req)

    expect(result).toEqual({ videoBase64: 'QUJD', mimeType: 'video/mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com')
    expect(vertexVideoBreaker.onSuccess).toHaveBeenCalledTimes(1)
    expect(geminiVideoBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('gemini failure → falls back to Vertex Veo', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'gemini boom' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/veo-2' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true, response: { videos: [{ bytesBase64Encoded: 'ZGVm', mimeType: 'video/mp4' }] } }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo(req)

    expect(result).toEqual({ videoBase64: 'ZGVm', mimeType: 'video/mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com')
    expect(fetchMock.mock.calls[1][0]).toContain('aiplatform.googleapis.com')
    expect(geminiVideoBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(vertexVideoBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('both gemini and vertex fail → throws with both reasons', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'gemini boom' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/gemini boom/i)
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(geminiVideoBreaker.onFailure).toHaveBeenCalledTimes(1)
    expect(vertexVideoBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('gemini circuit open + vertex circuit open → throws without calling either', async () => {
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(false)
    vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/circuit open/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
