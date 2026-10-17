import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchInstagramImage, MAX_IMAGE_BYTES } from './safeImage.js'

const fetchMock = vi.fn()
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock) })

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PIC = 'https://scontent-bom1-1.cdninstagram.com/v/t51/pic.jpg?x=1'

describe('fetchInstagramImage', () => {
  it.each([
    ['another host', 'https://evil.example/pic.jpg'],
    ['a look-alike host', 'https://cdninstagram.com.evil.example/pic.jpg'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['plain http', 'http://scontent.cdninstagram.com/pic.jpg'],
    ['not a URL', 'not a url'],
  ])('refuses %s without fetching', async (_n, url) => {
    expect(await fetchInstagramImage(url)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never follows a redirect', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    expect(await fetchInstagramImage(PIC)).toBeNull()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('stops reading past 5 MB', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    chunk.set(JPEG)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent++ < 10) c.enqueue(chunk); else c.close() },
    })
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }))
    expect(await fetchInstagramImage(PIC)).toBeNull()
    expect(sent).toBeLessThanOrEqual(Math.ceil(MAX_IMAGE_BYTES / chunk.length) + 2)
  })

  it('returns null for bytes that are not png, jpeg or webp', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from('GIF89a......'), { status: 200 }))
    expect(await fetchInstagramImage(PIC)).toBeNull()
  })

  it('returns null, never throws, when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'))
    expect(await fetchInstagramImage(PIC)).toBeNull()
  })

  it('returns a good jpeg as base64 with its sniffed type', async () => {
    fetchMock.mockResolvedValue(new Response(JPEG, { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await fetchInstagramImage('https://instagram.fbom1-2.fna.fbcdn.net/pic.jpg')).toEqual({ base64: JPEG.toString('base64'), mimeType: 'image/jpeg' })
  })
})
