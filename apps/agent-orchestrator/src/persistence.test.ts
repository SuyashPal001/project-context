import { describe, it, expect, vi, afterEach } from 'vitest'
import { generatedFileKey, uploadGeneratedFile, saveGenerationConfirmRequest, updateGenerationConfirmRequest } from './persistence.js'

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
    // body is wrapped as a Uint8Array (fetch's BodyInit type rejects Buffer
    // directly under TS's lib.dom types) — same bytes, not the same instance.
    expect(putCall?.init?.body).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(putCall?.init?.body as Uint8Array)).toEqual(buf)
    expect((putCall?.init?.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
  })
})

describe('saveGenerationConfirmRequest', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('POSTs to /messages/save with the generationConfirmRequest field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    global.fetch = fetchMock as unknown as typeof fetch

    saveGenerationConfirmRequest('tok', 'conv-1', 'msg-1', {
      id: 'gc-1', resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
      label: 'Generate image', status: 'pending',
    })

    // fire-and-forget — give the microtask queue a tick
    await new Promise(r => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/conversations/conv-1/messages/save')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.generationConfirmRequest).toEqual({
      id: 'gc-1', resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
      label: 'Generate image', status: 'pending',
    })
  })
})

describe('updateGenerationConfirmRequest', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('PATCHes /messages/:messageId/generation-confirm with the status update', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    updateGenerationConfirmRequest('tok', 'conv-1', 'msg-1', { status: 'approved', decisionAt: '2026-09-03T00:00:00.000Z' })

    await new Promise(r => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/conversations/conv-1/messages/msg-1/generation-confirm')
    expect((opts as RequestInit).method).toBe('PATCH')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.generationConfirmRequest).toEqual({ status: 'approved', decisionAt: '2026-09-03T00:00:00.000Z' })
  })
})
