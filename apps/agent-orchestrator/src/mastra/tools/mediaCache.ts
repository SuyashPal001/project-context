import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MEDIA_DIR, INTERNAL_API_URL } from '../../types.js'

export async function fetchPresignedUrl(fileId: string, idToken: string): Promise<string> {
  const res = await fetch(`${INTERNAL_API_URL}/files/${fileId}/presigned-url`, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!res.ok) throw new Error(`presigned-url fetch failed: HTTP ${res.status}`)
  const data = (await res.json()) as { presignedUrl?: string }
  if (!data.presignedUrl) throw new Error('presigned-url response missing presignedUrl')
  return data.presignedUrl
}

// sessionId:fileId -> { filePath, mimeType }. Lets multiple tool calls against the
// same attachment within one session reuse a single download instead of
// re-fetching from S3 each time.
const sessionCache = new Map<string, { filePath: string; mimeType: string }>()

export async function downloadToSessionCache(
  sessionId: string,
  fileId: string,
  presignedUrl: string,
  maxSizeBytes: number,
): Promise<{ filePath: string; buf: Buffer; mimeType: string }> {
  const cacheKey = `${sessionId}:${fileId}`
  const cached = sessionCache.get(cacheKey)
  if (cached && existsSync(cached.filePath)) {
    return { filePath: cached.filePath, buf: readFileSync(cached.filePath), mimeType: cached.mimeType }
  }

  const url = new URL(presignedUrl)
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`)

  const contentLength = res.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxSizeBytes) {
    throw new Error(`file too large: ${contentLength} bytes, ${maxSizeBytes} max`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxSizeBytes) {
    throw new Error(`file too large: ${buf.length} bytes, ${maxSizeBytes} max`)
  }

  const mimeType = res.headers.get('content-type') ?? 'application/octet-stream'
  mkdirSync(MEDIA_DIR, { recursive: true })
  const filePath = join(MEDIA_DIR, `${sessionId}-${fileId}`)
  writeFileSync(filePath, buf)
  sessionCache.set(cacheKey, { filePath, mimeType })
  return { filePath, buf, mimeType }
}
