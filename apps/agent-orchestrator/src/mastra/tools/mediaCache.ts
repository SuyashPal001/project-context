import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { MEDIA_DIR, INTERNAL_API_URL } from '../../types.js'

export async function fetchPresignedUrl(fileId: string, idToken: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${INTERNAL_API_URL}/files/${encodeURIComponent(fileId)}/presigned-url`, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal,
  })
  if (!res.ok) throw new Error(`presigned-url fetch failed: HTTP ${res.status}`)
  const data = (await res.json()) as { presignedUrl?: string }
  if (!data.presignedUrl) throw new Error('presigned-url response missing presignedUrl')
  return data.presignedUrl
}

// scopeId:fileId -> { filePath, mimeType }. `scopeId` is the caller's tenantId
// (falling back to sessionId when unavailable) rather than the SSE sessionId
// itself — sessionId is generated fresh per chat *turn* (see chat.ts), so
// keying on it meant a follow-up question about the same attachment in a
// later message re-downloaded and wrote a brand-new file to MEDIA_DIR every
// time, with nothing ever deleting the old ones. Keying on tenantId lets a
// download be reused across an entire conversation (and across conversations
// for the same tenant+file), which is also the more semantically correct
// scope — a given fileId's bytes don't change per turn.
const sessionCache = new Map<string, { filePath: string; mimeType: string }>()

// Belt-and-suspenders cleanup: even with a durable cache key, distinct files
// still accumulate on disk forever with nothing else deleting them. Prune
// anything older than this on every call rather than running a separate
// timer/cron — cheap, and keeps MEDIA_DIR bounded without new infra.
const CACHE_TTL_MS = 60 * 60 * 1000

function pruneStaleMediaFiles(): void {
  try {
    if (!existsSync(MEDIA_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(MEDIA_DIR)) {
      const filePath = join(MEDIA_DIR, f)
      try {
        if (now - statSync(filePath).mtimeMs > CACHE_TTL_MS) unlinkSync(filePath)
      } catch { /* file may have been removed concurrently — ignore */ }
    }
  } catch { /* never let pruning break a download */ }
}

export async function downloadToSessionCache(
  scopeId: string,
  fileId: string,
  presignedUrl: string,
  maxSizeBytes: number,
  signal?: AbortSignal,
): Promise<{ filePath: string; buf: Buffer; mimeType: string }> {
  pruneStaleMediaFiles()

  const cacheKey = `${scopeId}:${fileId}`
  const cached = sessionCache.get(cacheKey)
  if (cached && existsSync(cached.filePath)) {
    return { filePath: cached.filePath, buf: readFileSync(cached.filePath), mimeType: cached.mimeType }
  }

  const url = new URL(presignedUrl)
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString(), { signal })
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
  const filePath = join(MEDIA_DIR, `${scopeId}-${fileId}`)
  writeFileSync(filePath, buf)
  sessionCache.set(cacheKey, { filePath, mimeType })
  return { filePath, buf, mimeType }
}
