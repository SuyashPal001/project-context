import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Attachment, DownloadedMedia } from './types.js'
import { MEDIA_DIR } from './types.js'

async function transcribeAudio(
  buf: Buffer,
  mimeType: string,
  sessionId: string
): Promise<string | null> {
  try {
    const speech = new (await import('@google-cloud/speech')).SpeechClient({
      keyFilename: '/opt/agent-orchestrator/vertex-sa-key.json'
    })
    const encoding = mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'MP3'
      : mimeType.includes('wav') ? 'LINEAR16'
      : mimeType.includes('ogg') ? 'OGG_OPUS'
      : mimeType.includes('webm') ? 'WEBM_OPUS'
      : 'MP3'
    const [response] = await speech.recognize({
      audio: { content: buf.toString('base64') },
      config: {
        encoding,
        // WEBM_OPUS is always 48000 Hz; OGG_OPUS is 16000; LINEAR16 varies — omit for auto-detect
        ...(encoding === 'WEBM_OPUS' ? { sampleRateHertz: 48000 } : encoding === 'OGG_OPUS' ? { sampleRateHertz: 16000 } : {}),
        languageCode: 'en-US',
        enableAutomaticPunctuation: true
      }
    })
    const transcript = response.results
      ?.map(r => r.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(' ')
      .trim()
    console.log(`[session:${sessionId}] audio transcribed: ${transcript?.slice(0, 100)}`)
    return transcript || null
  } catch (err: any) {
    console.error(`[session:${sessionId}] transcription error:`, err.message)
    return null
  }
}

async function extractVideoFrames(
  filePath: string,
  name: string,
  sessionId: string
): Promise<DownloadedMedia[]> {
  const MAX_FRAMES = 8
  const frameDir = mkdtempSync(join(tmpdir(), 'vframes-'))
  try {
    // Get video duration
    let duration = 0
    try {
      const probe = execFileSync('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath
      ]).toString()
      const streams = (JSON.parse(probe) as { streams?: Array<{ codec_type: string; duration?: string }> }).streams ?? []
      const vs = streams.find(s => s.codec_type === 'video')
      duration = parseFloat(vs?.duration ?? '0') || 0
    } catch {}

    const interval = duration > 0 ? Math.max(1, duration / MAX_FRAMES) : 1
    const framePattern = join(frameDir, 'frame_%03d.jpg')
    execFileSync('ffmpeg', [
      '-i', filePath,
      '-vf', `fps=1/${interval},scale=1280:-1`,
      '-frames:v', String(MAX_FRAMES),
      '-q:v', '3',
      framePattern,
    ], { stdio: 'pipe' })

    const frameFiles = readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort()
    console.log(`[session:${sessionId}] video frames extracted: ${frameFiles.length}`)

    return frameFiles.map((f, i) => {
      const frameBuf = readFileSync(join(frameDir, f))
      return {
        filePath: join(frameDir, f),
        base64: `data:image/jpeg;base64,${frameBuf.toString('base64')}`,
        mimeType: 'image/jpeg',
        name: `${name}_frame${i + 1}.jpg`,
      }
    })
  } catch (err) {
    console.error(`[session:${sessionId}] video frame extraction error:`, (err as Error).message)
    return []
  } finally {
    try {
      for (const f of readdirSync(frameDir)) unlinkSync(join(frameDir, f))
      rmdirSync(frameDir)
    } catch {}
  }
}

export async function downloadMediaAttachment(att: Attachment, sessionId: string): Promise<DownloadedMedia | DownloadedMedia[] | null> {
  if (!att.presignedUrl) return null
  const name = att.name ?? att.fileId ?? 'attachment'
  const maxSize = (att.type?.startsWith('video/') ? 200 : 35) * 1024 * 1024
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
    if (att.type?.startsWith('video/')) {
      const frames = await extractVideoFrames(filePath, name, sessionId)
      if (frames.length > 0) return frames
      console.warn(`[session:${sessionId}] video frame extraction failed, skipping video attachment`)
      return null
    }
    if (att.type?.startsWith('audio/')) {
      const transcript = await transcribeAudio(buf, att.type, sessionId)
      if (transcript) {
        const textBase64 = `data:text/plain;base64,${Buffer.from(transcript).toString('base64')}`
        return { filePath, base64: textBase64, mimeType: 'text/plain', name }
      }
      console.warn(`[session:${sessionId}] transcription failed, sending raw audio`)
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
