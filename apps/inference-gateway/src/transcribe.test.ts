import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio, UnsupportedTranscribeModelError } from './transcribe.js'

describe('transcribeAudio', () => {
  const origKey = process.env.GEMINI_API_KEY
  beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key' })
  afterEach(() => {
    if (origKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origKey
    vi.restoreAllMocks()
  })

  it('sends the base64 audio to Gemini generateContent with a structured JSON responseSchema', async () => {
    const geminiFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          text: 'hello world',
          words: [
            { word: 'hello', startSeconds: 0.1, endSeconds: 0.4 },
            { word: 'world', startSeconds: 0.5, endSeconds: 0.9 },
          ],
        }) }] } }],
      }),
    })
    global.fetch = geminiFetch as unknown as typeof fetch

    const result = await transcribeAudio({ audioBase64: Buffer.from('fake-audio-bytes').toString('base64'), mimeType: 'audio/aac' })

    expect(result).toEqual({
      text: 'hello world',
      words: [
        { word: 'hello', startSeconds: 0.1, endSeconds: 0.4 },
        { word: 'world', startSeconds: 0.5, endSeconds: 0.9 },
      ],
    })
    expect(geminiFetch).toHaveBeenCalledTimes(1)
    const geminiCallArgs = geminiFetch.mock.calls[0]
    expect(geminiCallArgs[0]).toContain('generativelanguage.googleapis.com/v1beta/models/')
    expect(geminiCallArgs[0]).toContain(':generateContent')
    const body = JSON.parse(geminiCallArgs[1].body)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema.required).toEqual(['text', 'words'])
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe('audio/aac')
  })

  it('returns refused when Gemini responds with text that fails schema validation', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"text":"oops"}' }] } }] }),
    }) as unknown as typeof fetch

    const result = await transcribeAudio({ audioBase64: Buffer.from('x').toString('base64'), mimeType: 'audio/aac' })
    expect(result).toEqual({ refused: true, reason: expect.stringContaining('schema') })
  })

  it('returns refused when the decoded audio exceeds the size limit', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const oversized = Buffer.alloc(21 * 1024 * 1024).toString('base64')
    const result = await transcribeAudio({ audioBase64: oversized, mimeType: 'audio/aac' })
    expect(result).toEqual({ refused: true, reason: expect.stringContaining('size limit') })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws UnsupportedTranscribeModelError for an unlisted model override', async () => {
    await expect(
      transcribeAudio({ audioBase64: Buffer.from('x').toString('base64'), mimeType: 'audio/aac', model: 'not-a-real-model' }),
    ).rejects.toThrow(UnsupportedTranscribeModelError)
  })
})
