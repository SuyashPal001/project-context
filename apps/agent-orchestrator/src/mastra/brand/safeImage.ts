import { sniffImageMimeType } from '../../media.js'

// The Instagram profile picture URL comes from TikHub, a third party, so it is
// fetched as untrusted input: https only, Instagram's own CDNs only, no
// redirects (one could point anywhere), a short timeout and a byte cap.
const ALLOWED_HOST_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net']
const TIMEOUT_MS = 5_000
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function allowed(raw: string): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s))
  } catch {
    return false
  }
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<Buffer | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    total += value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
}

/** An Instagram CDN image as base64 with its sniffed type (png, jpeg or webp), or null. Never throws. */
export async function fetchInstagramImage(url: string): Promise<{ base64: string; mimeType: string } | null> {
  if (!allowed(url)) return null
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status !== 200 || !res.body) return null
    const buf = await readCapped(res.body)
    if (!buf) return null
    const mimeType = sniffImageMimeType(buf.subarray(0, 16))
    if (!mimeType || !ACCEPTED_TYPES.has(mimeType)) return null
    return { base64: buf.toString('base64'), mimeType }
  } catch (err) {
    console.error('[brandImport] profile picture fetch failed', { error: (err as Error).message })
    return null
  }
}
