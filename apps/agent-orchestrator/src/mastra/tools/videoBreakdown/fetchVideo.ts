import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { ffmpegToFile } from './atomicFfmpeg.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MEDIA_DIR } from '../../../types.js'
import { uploadGeneratedFile } from '../../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../mediaCache.js'

const execFile = promisify(execFileCb)
const MAX_SOURCE_BYTES = 300 * 1024 * 1024
export const MAX_FULL_BREAKDOWN_S = 90

export class FetchRefused extends Error {}
// The server could not download a YouTube link (YouTube blocks datacenter IPs).
// Gemini can still watch the link itself, so the breakdown falls back to watch-only.
export class DownloadBlocked extends FetchRefused {
  constructor(message: string, readonly youtubeUrl: string, readonly durationS: number | null, readonly caption: string | null, readonly song: FetchedVideo['song']) { super(message) }
}

export function classifyLink(url: string): 'youtube' | 'instagram' | 'x' | 'facebook' | 'linkedin' | 'tiktok' | 'other' {
  const h = (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } })()
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return 'youtube'
  if (/(^|\.)instagram\.com$/.test(h)) return 'instagram'
  if (/^(x|twitter)\.com$/.test(h)) return 'x'
  if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return 'facebook'
  if (/(^|\.)linkedin\.com$|^lnkd\.in$/.test(h)) return 'linkedin'
  if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok'
  return 'other'
}

export interface FetchedVideo { fileId: string; filePath: string; durationS: number; width: number; height: number; fps: number; hasAudio: boolean; caption: string | null; song: { name: string; artist: string | null } | null; youtubeUrl: string | null; platform: string; tooLong: boolean }

export async function probe(filePath: string) {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filePath], { timeout: 30_000 })
  const p = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }> }
  const v = p.streams.find((s) => s.codec_type === 'video')
  if (!v) throw new FetchRefused('That link has no video in it.')
  const [n, d] = (v.r_frame_rate ?? '30/1').split('/').map(Number)
  return { durationS: Math.round(parseFloat(p.format.duration) * 100) / 100, width: v.width ?? 0, height: v.height ?? 0, fps: d ? n / d : 30, codec: v.codec_name ?? '', hasAudio: p.streams.some((s) => s.codec_type === 'audio') }
}

export async function fetchVideo(input: { url?: string; fileId?: string }, ctx: { idToken: string; scopeId: string; conversationId: string }): Promise<FetchedVideo> {
  let filePath: string
  let caption: string | null = null
  let song: FetchedVideo['song'] = null
  let platform = 'upload'
  let youtubeUrl: string | null = null
  let fileId = input.fileId ?? ''
  let metaDurationS: number | null = null
  if (input.url) {
    platform = classifyLink(input.url)
    if (platform === 'tiktok') throw new FetchRefused('TikTok links can’t be opened from our servers in India. Please download the video from TikTok and upload it here.')
    // Only the platforms we support (spec §5.1); anything else would let a link make the VM fetch any host (review I7).
    if (platform === 'other') throw new FetchRefused('I can open YouTube, Instagram, X, Facebook and LinkedIn links. For anything else, please download the video and upload it here.')
    if (platform === 'youtube') youtubeUrl = input.url
    filePath = join(MEDIA_DIR, `${ctx.scopeId}-link-${createHash('sha256').update(input.url).digest('hex').slice(0, 16)}.mp4`)
    const sidecar = `${filePath}.meta.json`
    const cached = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) as { fileId: string; caption: string | null; song: FetchedVideo['song'] } : null
    if (cached) {
      ({ fileId, caption, song } = cached)
    } else {
      // Metadata first: a long video is refused before any download, convert or Drive upload (review I3).
      let durationS = 0
      try {
        const { stdout } = await execFile('yt-dlp', ['-q', '--no-warnings', '--no-playlist', '--skip-download', '--print', '%(duration)s', '--print', '%(uploader)s | %(title)s', '--print', '%(track)s\t%(artist)s', '--', input.url], { timeout: 60_000 })
        const [durLine = '', captionLine = '', songLine = ''] = stdout.split('\n')
        durationS = parseFloat(durLine) || 0
        metaDurationS = durationS || null
        caption = captionLine.trim().slice(0, 500) || null
        const [track, artist] = songLine.split('\t').map((x) => x.trim())
        // Song facts only from the platform's own metadata — never guessed (spec §9a).
        song = track && track !== 'NA' ? { name: track, artist: artist && artist !== 'NA' ? artist : null } : null
      } catch { /* metadata is best-effort; the download below reports real failures */ }
      if (durationS > MAX_FULL_BREAKDOWN_S) {
        return { fileId: '', filePath: '', durationS, width: 0, height: 0, fps: 0, hasAudio: false, caption, song, youtubeUrl, platform, tooLong: true }
      }
    }
    if (!existsSync(filePath)) {
      try {
        // Logged-out only (spec §11): never add cookies or an account here.
        await execFile('yt-dlp', ['-q', '--no-warnings', '--no-playlist', '--max-filesize', '300M', '-S', 'vcodec:h264,res:1080,acodec:m4a', '--merge-output-format', 'mp4', '-o', filePath, '--', input.url], { timeout: 240_000 })
      } catch (err) {
        const msg = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message}`
        // For us only (the user gets the plain upload message below): the real reason, so a
        // failed link can be diagnosed from the logs without digging through the database.
        console.error(`[fetchVideo] download failed platform=${platform} url=${input.url} :: ${msg.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
        if (platform === 'youtube') throw new DownloadBlocked('YouTube didn’t let our server download that video. For exact timing and poses, please download it and upload it here.', input.url, metaDurationS, caption, song)
        throw new FetchRefused(/not granting access|login|private|cookies/i.test(msg)
          ? 'That post can’t be opened without logging in. Please download the video and upload it here.'
          : 'I couldn’t download that link. Please download the video and upload it here.')
      }
    }
  } else if (input.fileId) {
    const url = await fetchPresignedUrl(input.fileId, ctx.idToken)
    filePath = (await downloadToSessionCache(ctx.scopeId, input.fileId, url, MAX_SOURCE_BYTES)).filePath
  } else {
    throw new FetchRefused('Send a video link or attach a video.')
  }
  let meta = await probe(filePath)
  if (meta.codec !== 'h264') {
    const conv = filePath.replace(/\.mp4$/, '') + '.h264.mp4'
    await ffmpegToFile(['-v', 'error', '-y', '-i', filePath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac'], conv, { timeout: 300_000 })
    filePath = conv
    meta = await probe(filePath)
  }
  if (input.url && !fileId) {
    const saved = await uploadGeneratedFile(ctx.idToken, { conversationId: ctx.conversationId, title: `Reference video (${platform})`, content: readFileSync(filePath), contentType: 'video/mp4', extension: 'mp4' })
    if (!saved) throw new Error('could not save the reference video')
    fileId = saved.fileId
    // One Drive copy per link: later tool calls reuse it (review I4).
    writeFileSync(`${filePath.replace(/\.h264\.mp4$/, '.mp4')}.meta.json`, JSON.stringify({ fileId, caption, song }))
  }
  return { fileId, filePath, durationS: meta.durationS, width: meta.width, height: meta.height, fps: meta.fps, hasAudio: meta.hasAudio, caption, song, youtubeUrl, platform, tooLong: meta.durationS > MAX_FULL_BREAKDOWN_S }
}

export const fetchVideoTool = createTool({
  id: 'fetch_video',
  description: 'Get a reference video from a social link (YouTube, Instagram, X, Facebook, LinkedIn) or an attached file, ready for breaking down. Logged-out downloads only; TikTok needs an upload. Returns fileId, length, size, caption and tooLong (over 90s: ask the user which part to clone).',
  inputSchema: z.object({ url: z.string().url().optional(), fileId: z.string().optional() }),
  outputSchema: z.object({ success: z.boolean(), video: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const conversationId = (execContext?.requestContext?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      const video = await fetchVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId })
      return { success: true, video }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
