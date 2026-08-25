import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync, mkdtempSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Attachment, DownloadedMedia } from './types.js'
import { MEDIA_DIR } from './types.js'

const execFile = promisify(execFileCb)

// Bounds ffprobe/ffmpeg wall-clock time so a single tool call can't hang the
// process indefinitely on a pathological input file. Generous relative to the
// analyze_video tool's own QUICK/DEEP timeouts since this is only one leg of
// that pipeline (see analyzeVideo.ts).
const FFMPEG_TIMEOUT_MS = 60_000

export async function extractVideoFrames(
  filePath: string,
  name: string,
  sessionId: string,
  maxFrames = 8,
  // Lets analyzeVideo.ts thread its overall per-call deadline through this
  // leg too, on top of the fixed FFMPEG_TIMEOUT_MS floor below.
  signal?: AbortSignal,
): Promise<DownloadedMedia[]> {
  let frameDir: string | undefined
  try {
    frameDir = mkdtempSync(join(tmpdir(), 'vframes-'))
    const dir = frameDir
    let duration = 0
    try {
      const { stdout: probe } = await execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
      ], { timeout: FFMPEG_TIMEOUT_MS, signal })
      const streams = (JSON.parse(probe) as { streams?: Array<{ codec_type: string; duration?: string }> }).streams ?? []
      const vs = streams.find(s => s.codec_type === 'video')
      duration = parseFloat(vs?.duration ?? '0') || 0
    } catch {}

    const interval = duration > 0 ? Math.max(1, duration / maxFrames) : 1
    const framePattern = join(dir, 'frame_%03d.jpg')
    await execFile('ffmpeg', [
      '-i', filePath,
      '-vf', `fps=1/${interval},scale=1280:-1`,
      '-frames:v', String(maxFrames),
      '-q:v', '3',
      framePattern,
    ], { timeout: FFMPEG_TIMEOUT_MS, signal })

    const frameFiles = readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()
    console.log(`[session:${sessionId}] video frames extracted: ${frameFiles.length}`)

    return frameFiles.map((f, i) => {
      const frameBuf = readFileSync(join(dir, f))
      return {
        filePath: join(dir, f),
        base64: `data:image/jpeg;base64,${frameBuf.toString('base64')}`,
        mimeType: 'image/jpeg',
        name: `${name}_frame${i + 1}.jpg`,
      }
    })
  } catch (err) {
    console.error(`[session:${sessionId}] video frame extraction error:`, (err as Error).message)
    return []
  } finally {
    if (frameDir) {
      try {
        for (const f of readdirSync(frameDir)) unlinkSync(join(frameDir, f))
        rmdirSync(frameDir)
      } catch {}
    }
  }
}

// audio/* and video/* attachments never go through the synchronous
// download/decode path (downloadMediaAttachment below) on any request path —
// both require slow processing (frame extraction, full-file transcription)
// that has no business blocking a live chat turn. Routing them through a
// synchronous path held the connection open with no bytes flowing for the
// length of the processing call, which Cloudflare's edge would kill as a
// QUIC protocol error. Instead, the agent is told these attachments exist so
// it can call analyze_audio/analyze_video (Mastra tools, see
// mastra/tools/analyzeAudio.ts and analyzeVideo.ts) on demand, mid-turn, only
// if it actually needs to understand their content. Both attachment types
// still reach chat history via saveUserMessage() regardless of whether the
// tool is ever called.
//
// Shared by both the SSE path (routes/chatStream.ts) and the WebSocket path
// (index.ts) so the two stay in sync — filtered separately here rather than
// downloaded, since the whole point is to skip synchronous processing.
export function buildAttachmentNote(attachments: Attachment[]): string {
  const understandableAttachments = attachments.filter(
    (a) => (a.type?.startsWith('audio/') || a.type?.startsWith('video/')) && !!a.fileId
  )
  if (understandableAttachments.length === 0) return ''
  return '<attachments>\n' + understandableAttachments.map((a) => {
    const kind = a.type?.startsWith('audio/') ? 'audio' : 'video'
    const tool = kind === 'audio' ? 'analyze_audio' : 'analyze_video'
    return `- ${kind}: "${a.name ?? a.fileId ?? 'attachment'}" (fileId: ${a.fileId}) — call ${tool} if you need to understand its content`
  }).join('\n') + '\n</attachments>\n\n'
}

export async function downloadMediaAttachment(att: Attachment, sessionId: string): Promise<DownloadedMedia | DownloadedMedia[] | null> {
  if (!att.presignedUrl) return null
  const name = att.name ?? att.fileId ?? 'attachment'
  const maxSize = 35 * 1024 * 1024
  if (att.size && att.size > maxSize) {
    console.error(`[session:${sessionId}] attachment "${name}" too large: ${att.size} bytes, skipping`)
    return null
  }
  try {
    const url = new URL(att.presignedUrl)
    url.searchParams.delete('x-amz-checksum-mode')
    const res = await fetch(url.toString())
    if (!res.ok) {
      console.error(`[session:${sessionId}] media download failed "${name}": HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = att.type?.split('/')[1] ?? 'bin'
    const safeName = `${Date.now()}-${name.replace(/[^a-zA-Z0-9._\- ]/g, '_')}.${ext}`
    const filePath = join(MEDIA_DIR, safeName)
    mkdirSync(MEDIA_DIR, { recursive: true })
    writeFileSync(filePath, buf)
    // Convert DOCX to plain text for model context
    if (att.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: buf })
      const text = result.value.trim()
      const textBase64 = `data:text/plain;base64,${Buffer.from(text).toString('base64')}`
      return { filePath, base64: textBase64, mimeType: 'text/plain', name }
    }
    if (att.type === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: new Uint8Array(buf) })
      const data = await parser.getText()
      const text = data.text.trim()
      if (text.length > 0) {
        const textBase64 = `data:text/plain;base64,${Buffer.from(text).toString('base64')}`
        console.log(`[session:${sessionId}] pdf text extracted: ${text.length} chars, sending as text/plain`)
        return { filePath, base64: textBase64, mimeType: 'text/plain', name }
      }
      // If no text extracted (scanned PDF), fall through to raw base64
    }
    const mimeType = att.type ?? 'application/octet-stream'
    const base64 = `data:${mimeType};base64,${buf.toString('base64')}`
    console.log(`[session:${sessionId}] media saved: ${filePath} (${buf.length} bytes), base64 prefix: ${base64.slice(0, 40)}`)
    return { filePath, base64, mimeType, name }
  } catch (err) {
    console.error(`[session:${sessionId}] media download error "${name}":`, (err as Error).message)
    return null
  }
}
