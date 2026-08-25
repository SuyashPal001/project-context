import { describe, it, expect, vi, afterEach } from 'vitest'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetchPresignedUrl, downloadToSessionCache } from '../mediaCache.js'
import { MEDIA_DIR } from '../../../types.js'

describe('fetchPresignedUrl', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the presignedUrl from a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ presignedUrl: 'https://example.com/signed' }),
    }))
    const url = await fetchPresignedUrl('file-1', 'token-1')
    expect(url).toBe('https://example.com/signed')
  })

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(fetchPresignedUrl('missing', 'token-1')).rejects.toThrow('404')
  })
})

describe('downloadToSessionCache', () => {
  const testPaths: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const p of testPaths) { try { unlinkSync(p) } catch {} }
    testPaths.length = 0
  })

  it('downloads, writes to MEDIA_DIR, and returns buf + mimeType', async () => {
    const body = Buffer.from('fake-audio-bytes')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : h === 'content-type' ? 'audio/mpeg' : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }))
    const result = await downloadToSessionCache('session-1', 'file-1', 'https://example.com/signed', 1024)
    testPaths.push(result.filePath)
    expect(result.buf.toString()).toBe('fake-audio-bytes')
    expect(result.mimeType).toBe('audio/mpeg')
    expect(existsSync(join(MEDIA_DIR, 'session-1-file-1'))).toBe(true)
  })

  it('reuses the cached file on a second call without re-fetching', async () => {
    const body = Buffer.from('cached-bytes')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : h === 'content-type' ? 'audio/mpeg' : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = await downloadToSessionCache('session-2', 'file-2', 'https://example.com/signed', 1024)
    testPaths.push(first.filePath)
    const second = await downloadToSessionCache('session-2', 'file-2', 'https://example.com/signed', 1024)
    expect(second.filePath).toBe(first.filePath)
    expect(second.mimeType).toBe(first.mimeType)
    expect(second.mimeType).toBe('audio/mpeg')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects when content-length exceeds maxSizeBytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? '99999999' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    await expect(downloadToSessionCache('session-3', 'file-3', 'https://example.com/signed', 1024))
      .rejects.toThrow('too large')
  })
})
