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

import { classifyVertexMusicResponse, generateMusic, lyria3Body } from './music'
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

describe('lyria-002 stays byte-identical (Review Focus 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends exactly the old URL, headers and body, even when a lyrics field is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }] }) })
    vi.stubGlobal('fetch', fetchMock)
    await generateMusic({ model: 'lyria-002', prompt: 'a calm lo-fi beat', lyrics: ['ignored'] })
    const [url, init] = fetchMock.mock.calls[0]
    const loc = process.env.VERTEX_LOCATION ?? 'us-central1'
    expect(url).toMatch(new RegExp(`^https://${loc}-aiplatform\\.googleapis\\.com/v1/projects/[^/]*/locations/${loc}/publishers/google/models/lyria-002:predict$`))
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ instances: [{ prompt: 'a calm lo-fi beat' }] }))
  })
})

describe('Lyria 3 (lyria-3-clip-preview)', () => {
  const req = { model: 'lyria-3-clip-preview', prompt: 'bright pop, female vocal, 120 bpm', lyrics: ['Every bubble, every sip', 'Bubbli, feel the magic'] }
  const okBody = {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [
        { text: '[0.0:6.2] Every bubble, every sip' },
        { text: '[22.1:25.0] Bubbli, feel the magic' },
        { inlineData: { mimeType: 'audio/mpeg', data: 'TVAz' } },
      ] },
    }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('builds the prompt with a Lyrics section and asks for audio and text', () => {
    expect(lyria3Body('bright pop', ['Every sip', 'Bubbli, feel the magic'])).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'bright pop\n\nLyrics:\n[Chorus]\nEvery sip\nBubbli, feel the magic' }] }],
      generationConfig: { responseModalities: ['AUDIO', 'TEXT'] },
    })
    expect(lyria3Body('bright pop')).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'bright pop' }] }],
      generationConfig: { responseModalities: ['AUDIO', 'TEXT'] },
    })
  })

  it('posts to the global generateContent endpoint and returns MP3 plus the joined lyrics text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateMusic(req)
    expect(result).toEqual({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[^/]*\/locations\/global\/publishers\/google\/models\/lyria-3-clip-preview:generateContent$/)
    expect(JSON.parse(init.body)).toEqual(lyria3Body(req.prompt, req.lyrics))
    expect(JSON.parse(init.body).generationConfig.responseModalities).toEqual(['AUDIO', 'TEXT'])
    expect(vertexMusicBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('a reply with no audio part is NO_AUDIO_BYTES', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'NO_AUDIO_BYTES' })
  })

  it.each([
    ['a prompt block', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }],
    ['a safety finish', { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }],
  ])('maps %s to CONTENT_BLOCKED without tripping the breaker', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
    expect(vertexMusicBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('maps a Responsible AI 400 to CONTENT_BLOCKED without tripping the breaker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"code":400,"message":"The prompt could not be submitted. It violated Google\'s Responsible AI practices."}}' }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
    expect(vertexMusicBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('retries Lyria\'s transient 500 once, like lyria-002', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Could not generate audio' })
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)
    const p = generateMusic(req)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await p).toMatchObject({ audioBase64: 'TVAz' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a plain 503 is a clean throw that counts against the breaker (no fallback tier)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' }))
    await expect(generateMusic(req)).rejects.toThrow(/503/)
    expect(vertexMusicBreaker.onFailure).toHaveBeenCalledTimes(1)
  })
})
