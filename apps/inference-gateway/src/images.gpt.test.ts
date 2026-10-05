import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexImageBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
  geminiImageBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
}))
vi.mock('google-auth-library', () => ({ GoogleAuth: class { async getClient() { return { getAccessToken: async () => ({ token: 't' }) } } } }))

import { generateImage, gptImageSize, classifyOpenAIImageResponse } from './images'

describe('gptImageSize', () => {
  it('makes every shape directly, sides divisible by 16', () => {
    expect(gptImageSize('9:16')).toBe('864x1536')
    expect(gptImageSize('3:4')).toBe('1152x1536')
    expect(gptImageSize('3:4', '2K')).toBe('1536x2048')
    expect(gptImageSize('9:16', '2K')).toBe('1152x2048')
    expect(gptImageSize(undefined)).toBe('1024x1024')
    for (const r of ['1:1', '3:4', '4:3', '9:16', '16:9']) for (const k of ['1K', '2K']) {
      const [w, h] = gptImageSize(r, k).split('x').map(Number)
      expect(w % 16 + h % 16).toBe(0)
    }
  })
})

describe('GPT Image 2 via OpenAI', () => {
  const orig = process.env.OPENAI_API_KEY
  afterEach(() => { if (orig === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = orig; vi.restoreAllMocks() })

  it('generates from text with size and quality, and reads b64_json', async () => {
    process.env.OPENAI_API_KEY = 'k'
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }], output_format: 'png' })))
    global.fetch = f as unknown as typeof fetch
    expect(await generateImage({ model: 'gpt-image-2', prompt: 'a woman', aspectRatio: '3:4' })).toEqual({ imageBase64: 'QUJD', mimeType: 'image/png' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-image-2', size: '1152x1536', quality: 'high' })
  })

  it('sends references to the edits endpoint as image[] files', async () => {
    process.env.OPENAI_API_KEY = 'k'
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }] })))
    global.fetch = f as unknown as typeof fetch
    await generateImage({ model: 'gpt-image-2', prompt: 'sheet', aspectRatio: '3:4', imageSize: '2K', sourceImages: [{ base64: 'QUJD', mimeType: 'image/png' }, { base64: 'QUJD', mimeType: 'image/jpeg' }] })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/edits')
    const form = init.body as FormData
    expect(form.getAll('image[]')).toHaveLength(2)
    expect(form.get('size')).toBe('1536x2048')
  })

  it('reads a moderation block as a refusal, and fails without a key', async () => {
    expect(classifyOpenAIImageResponse(400, { error: { code: 'moderation_blocked', message: 'x' } })).toEqual({ refused: true, reason: 'SAFETY' })
    delete process.env.OPENAI_API_KEY
    await expect(generateImage({ model: 'gpt-image-2', prompt: 'x' })).rejects.toThrow(/OPENAI_API_KEY/)
  })
})
