import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { uploadGeneratedFile, generatedFileKey, saveAssistantMessage } from '../persistence.js'

const ORIGINAL_FETCH = global.fetch

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('generatedFileKey', () => {
  it('scopes the key to the conversation and never collides on title alone', () => {
    const a = generatedFileKey('conv-1', 'Q3 Analysis')
    const b = generatedFileKey('conv-1', 'Q3 Analysis')
    expect(a).not.toBe(b)
    expect(a.startsWith('generated/conv-1/')).toBe(true)
    expect(a.endsWith('.md')).toBe(true)
  })

  it('slugifies the title without leaking path separators', () => {
    const key = generatedFileKey('conv-1', '../../etc/passwd')
    expect(key.includes('..')).toBe(false)
    expect(key.split('/').length).toBe(3)
  })

  it('falls back to a stable stem when the title slugifies to nothing', () => {
    const key = generatedFileKey('conv-1', '///')
    expect(key.startsWith('generated/conv-1/')).toBe(true)
    expect(key.endsWith('-document.md')).toBe(true)
  })
})

describe('uploadGeneratedFile', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { global.fetch = ORIGINAL_FETCH })

  it('runs upload -> PUT -> confirm and returns the attachment', async () => {
    const calls: string[] = []
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url)
      calls.push(`${init?.method ?? 'GET'} ${u.replace(/^https?:\/\/[^/]+/, '')}`)
      if (u.includes('/files/upload')) return jsonResponse({ data: { fileId: 'file-1', uploadUrl: 'https://s3.test/put' } }, 201)
      if (u === 'https://s3.test/put') return jsonResponse({}, 200)
      if (u.includes('/confirm')) return jsonResponse({ success: true, fileId: 'file-1' }, 200)
      throw new Error(`unexpected fetch: ${u}`)
    }) as any

    const att = await uploadGeneratedFile('tok', { conversationId: 'c1', title: 'Q3 Analysis', content: '# hi' })

    expect(att).toEqual({
      fileId: 'file-1',
      name: 'Q3 Analysis.md',
      type: 'text/markdown',
      size: Buffer.byteLength('# hi'),
    })
    expect(calls[0]).toBe('POST /api/v1/files/upload')
    expect(calls[1]).toBe('PUT /put')
    expect(calls[2]).toBe('POST /api/v1/files/file-1/confirm')
  })

  it('returns null rather than throwing when the presigned PUT fails', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/files/upload')) return jsonResponse({ data: { fileId: 'file-1', uploadUrl: 'https://s3.test/put' } }, 201)
      return jsonResponse({ error: 'nope' }, 403)
    }) as any

    await expect(uploadGeneratedFile('tok', { conversationId: 'c1', title: 'T', content: 'x' })).resolves.toBeNull()
  })

  it('returns null when the upload call gives back no fileId', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ data: {} }, 201)) as any
    await expect(uploadGeneratedFile('tok', { conversationId: 'c1', title: 'T', content: 'x' })).resolves.toBeNull()
  })
})

describe('saveAssistantMessage attachments passthrough', () => {
  afterEach(() => { global.fetch = ORIGINAL_FETCH })

  it('forwards attachments in the saved payload', async () => {
    let body: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return jsonResponse({}, 200)
    }) as any

    const atts = [{ fileId: 'file-1', name: 'a.md', type: 'text/markdown', size: 4 }]
    saveAssistantMessage('tok', 'c1', 'text', 'm1', null, null, atts)
    await vi.waitFor(() => expect(body).toBeDefined())
    expect(body.attachments).toEqual(atts)
  })

  it('omits attachments entirely when there are none', async () => {
    let body: any
    global.fetch = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return jsonResponse({}, 200)
    }) as any

    saveAssistantMessage('tok', 'c1', 'text', 'm1', null, null, [])
    await vi.waitFor(() => expect(body).toBeDefined())
    expect('attachments' in body).toBe(false)
  })
})
