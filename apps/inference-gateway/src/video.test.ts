import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  geminiVideoBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
}))

import { classifyInteractionsVideoResponse, generateVideo } from './video'
import { geminiVideoBreaker } from './router.js'

describe('classifyInteractionsVideoResponse', () => {
  it('extracts base64 video bytes from a normal interactions response', () => {
    const interactionResponse = {
      steps: [
        {
          content: [
            { type: 'text', text: 'here you go' },
            { type: 'video', video: { data: 'QUJD', mime_type: 'video/mp4' } },
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
        { content: [{ type: 'video', video: { data: 'ZGVm', mime_type: 'video/mp4' } }] },
      ],
    }
    expect(classifyInteractionsVideoResponse(interactionResponse)).toEqual({
      videoBase64: 'ZGVm',
      mimeType: 'video/mp4',
    })
  })
})

describe('generateVideo — single-path invariant (API-key only, no Vertex tier)', () => {
  const req: { model: string; prompt: string; task: 'text_to_video' } = {
    model: 'gemini-omni-1.1-flash',
    prompt: 'a calm sunrise over mountains',
    task: 'text_to_video',
  }
  const okBody = {
    steps: [{ content: [{ type: 'video', video: { data: 'QUJD', mime_type: 'video/mp4' } }] }],
  }
  const originalKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
    process.env.GEMINI_API_KEY = 'fake-api-key'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  })

  it('gemini API key success → returns video bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo(req)

    expect(result).toEqual({ videoBase64: 'QUJD', mimeType: 'video/mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com/v1beta/interactions')
    expect(fetchMock.mock.calls[0][0]).not.toContain('aiplatform.googleapis.com')
    expect(geminiVideoBreaker.onSuccess).toHaveBeenCalledTimes(1)

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sentBody).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: 'a calm sunrise over mountains',
      response_format: { type: 'video', resolution: '720p', delivery: 'base64' },
      generation_config: { video_config: { task: 'text_to_video' } },
    })
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

  it('rejects when no GEMINI_API_KEY is configured, before making any call', async () => {
    delete process.env.GEMINI_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/GEMINI_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('upstream failure → throws cleanly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'gemini boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/gemini boom/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(geminiVideoBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('circuit open → throws cleanly without attempting a call', async () => {
    vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/circuit open/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
