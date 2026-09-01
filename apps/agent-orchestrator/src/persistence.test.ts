import { describe, it, expect, vi, afterEach } from 'vitest'
import { generatedFileKey, uploadGeneratedFile } from './persistence'

describe('generatedFileKey', () => {
  it('uses the given extension instead of always .md', () => {
    const key = generatedFileKey('conv-1', 'A Generated Image', 'png')
    expect(key).toMatch(/^generated\/conv-1\/.+-a-generated-image\.png$/)
  })

  it('defaults to .md when no extension is given', () => {
    const key = generatedFileKey('conv-1', 'A Doc')
    expect(key).toMatch(/\.md$/)
  })
})

describe('uploadGeneratedFile — binary content', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('uploads a Buffer with the given contentType and byte size, not string length', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]) // fake JPEG magic bytes
    const calls: Array<{ url: string; init?: RequestInit }> = []
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/files/upload')) {
        return new Response(JSON.stringify({ data: { fileId: 'f1', uploadUrl: 'https://s3.example/put' } }), { status: 200 })
      }
      if (String(url) === 'https://s3.example/put') {
        return new Response(null, { status: 200 })
      }
      if (String(url).endsWith('/confirm')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      throw new Error('unexpected fetch: ' + url)
    }) as unknown as typeof fetch

    const result = await uploadGeneratedFile('tok', {
      conversationId: 'conv-1',
      title: 'Generated Image',
      content: buf,
      contentType: 'image/jpeg',
      extension: 'jpg',
    })

    expect(result).toEqual({ fileId: 'f1', name: 'Generated Image.jpg', type: 'image/jpeg', size: buf.length })
    const putCall = calls.find(c => c.url === 'https://s3.example/put')
    expect(putCall?.init?.body).toBe(buf)
    expect((putCall?.init?.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
  })
})
