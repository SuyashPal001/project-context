import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyLink, fetchVideo, FetchRefused } from './fetchVideo.js'

const execCalls: Array<{ file: string; args: string[] }> = []
let probeJson = ''
let ytdlpFails = ''
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    execCalls.push({ file, args })
    if (file === 'yt-dlp' && ytdlpFails) return cb(Object.assign(new Error('yt-dlp failed'), { stderr: ytdlpFails }))
    if (file === 'ffprobe') return cb(null, { stdout: probeJson, stderr: '' })
    if (file === 'yt-dlp' && args.includes('--print')) return cb(null, { stdout: 'author | caption text\nAs It Was\tHarry Styles\n', stderr: '' })
    cb(null, { stdout: '', stderr: '' })
  },
}))
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), readFileSync: vi.fn(() => Buffer.from('mp4')), existsSync: vi.fn(() => false) }))
vi.mock('../../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async () => ({ fileId: 'file-new', name: 'x.mp4', type: 'video/mp4', size: 3 })) }))
vi.mock('../mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async () => 'https://s3/x'), downloadToSessionCache: vi.fn(async () => ({ filePath: '/cache/s-f.mp4', buf: Buffer.from(''), mimeType: 'video/mp4' })) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const probe = (codec: string, dur: number) => JSON.stringify({ format: { duration: String(dur) }, streams: [{ codec_type: 'video', codec_name: codec, width: 720, height: 1280, r_frame_rate: '30/1' }, { codec_type: 'audio' }] })

beforeEach(() => { execCalls.length = 0; ytdlpFails = ''; probeJson = probe('h264', 15) })

describe('classifyLink', () => {
  it('knows the platforms, including short links', () => {
    expect(classifyLink('https://youtu.be/abc')).toBe('youtube')
    expect(classifyLink('https://www.instagram.com/p/x/')).toBe('instagram')
    expect(classifyLink('https://x.com/a/status/1')).toBe('x')
    expect(classifyLink('https://www.facebook.com/reel/1')).toBe('facebook')
    expect(classifyLink('https://lnkd.in/p/abc')).toBe('linkedin')
    expect(classifyLink('https://www.tiktok.com/@a/video/1')).toBe('tiktok')
  })
})

describe('fetchVideo', () => {
  it('refuses TikTok with an upload message and never runs yt-dlp', async () => {
    await expect(fetchVideo({ url: 'https://www.tiktok.com/@a/video/1' }, ctx)).rejects.toBeInstanceOf(FetchRefused)
    expect(execCalls.find((c) => c.file === 'yt-dlp')).toBeUndefined()
  })
  it('downloads logged-out with the H.264 preference and no cookies', async () => {
    await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    const dl = execCalls.find((c) => c.file === 'yt-dlp' && !c.args.includes('--print'))!
    expect(dl.args).toEqual(expect.arrayContaining(['-S', 'vcodec:h264,res:1080,acodec:m4a', '--merge-output-format', 'mp4']))
    expect(dl.args.join(' ')).not.toMatch(/cookies/)
  })
  it('converts a non-H.264 download with ffmpeg', async () => {
    probeJson = probe('vp9', 15)
    await fetchVideo({ url: 'https://www.facebook.com/reel/1' }, ctx)
    expect(execCalls.some((c) => c.file === 'ffmpeg' && c.args.includes('libx264'))).toBe(true)
  })
  it('keeps the YouTube URL for Gemini', async () => {
    const v = await fetchVideo({ url: 'https://www.youtube.com/watch?v=abc' }, ctx)
    expect(v.youtubeUrl).toBe('https://www.youtube.com/watch?v=abc')
  })
  it('keeps the song name and artist from platform metadata', async () => {
    const v = await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(v.song).toEqual({ name: 'As It Was', artist: 'Harry Styles' })
  })
  it('flags videos over 90s as tooLong', async () => {
    probeJson = probe('h264', 178)
    const v = await fetchVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(v.tooLong).toBe(true)
  })
  it('turns an Instagram "not granting access" failure into a FetchRefused asking for an upload', async () => {
    ytdlpFails = 'ERROR: [Instagram] x: Instagram API is not granting access'
    await expect(fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)).rejects.toThrow(/upload/)
  })
})
