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

describe('generateVideo — Gemini Omni only, no cross-vendor fallback', () => {
  const req = {
    model: 'gemini-omni-1.1-flash',
    prompt: 'a calm sunrise over mountains',
    task: 'text_to_video' as const,
    aspectRatio: '16:9' as const,
    durationSeconds: 8,
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

  it('does not fall back to Veo on a Gemini failure — surfaces the error instead', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    process.env.VERTEX_PROJECT = 'proj'
    vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('generativelanguage')) return new Response('boom', { status: 500 })
      throw new Error('Veo should never be called on a Gemini failure')
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 }))
      .rejects.toThrow(/Gemini API video generation failed/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('errors, rather than substituting a vendor, when Gemini is unconfigured', async () => {
    delete process.env.GEMINI_API_KEY
    const fetchSpy = vi.fn(() => { throw new Error('no backend should be called') })
    global.fetch = fetchSpy as unknown as typeof fetch

    await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 }))
      .rejects.toThrow(/no GEMINI_API_KEY configured/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('gemini circuit open → throws without calling fetch', async () => {
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

  it('rejects a duration outside the 3-10s Omni range before calling the gateway', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 11 }))
      .rejects.toThrow(/durationSeconds must be a whole number of seconds in 3\.\.10/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends aspect_ratio and duration on the Interactions request_format', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
    global.fetch = fetchSpy as unknown as typeof fetch

    await generateVideo({ ...req, aspectRatio: '9:16', durationSeconds: 6 })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.response_format).toMatchObject({ aspect_ratio: '9:16', duration: '6s' })
  })

  it('sends a multimodal input array with a Files-API-staged image part when imageUri is set', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    const stagedUri = 'https://generativelanguage.googleapis.com/v1beta/files/abc123'
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url)
      if (urlStr.includes('/upload/v1beta/files')) {
        return new Response(JSON.stringify({ file: { uri: stagedUri } }), { status: 200 })
      }
      if (urlStr === 'https://example.com/product.jpg') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }
      return new Response(JSON.stringify(okBody), { status: 200 })
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    await generateVideo({
      ...req, aspectRatio: '9:16', durationSeconds: 6,
      task: 'image_to_video', imageUri: 'https://example.com/product.jpg',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const [, init] = fetchSpy.mock.calls[2] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input).toEqual([
      { type: 'text', text: req.prompt },
      { type: 'image', uri: stagedUri, mime_type: 'image/jpeg' },
    ])
    expect(body.generation_config.video_config.task).toBe('image_to_video')

    // Regression: the Files API upload MUST carry uploadType=multipart on the
    // URL, a canonical `ref.<ext>` display_name (not a caller-controlled or
    // timestamped one), and a canonicalised image Content-Type — without
    // these, Google returns "Metadata part is too large" and the whole video
    // path 503s.
    const [uploadUrl, uploadInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(uploadUrl)).toContain('uploadType=multipart')
    const uploadBody = Buffer.isBuffer(uploadInit.body) ? uploadInit.body.toString('utf-8', 0, 400) : String(uploadInit.body).slice(0, 400)
    expect(uploadBody).toContain('"display_name":"ref.jpg"')
    expect(uploadBody).toContain('Content-Type: image/jpeg')
  })

  it('still sends a bare string input for text_to_video (no regression)', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
    global.fetch = fetchSpy as unknown as typeof fetch

    await generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input).toBe(req.prompt)
  })

  it('keeps the wire-level model id in the allowlist unnamespaced — only the credit rate subject is namespaced', async () => {
    process.env.GEMINI_API_KEY = 'key'
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody }))

    await expect(generateVideo({ ...req, model: 'gemini-omni-1.1-flash', aspectRatio: '16:9', durationSeconds: 8 }))
      .resolves.not.toBeUndefined()
  })

})
