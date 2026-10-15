import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyLink, fetchVideo, FetchRefused, DownloadBlocked, normalizeLink } from './fetchVideo.js'
import { uploadGeneratedFile } from '../../../persistence.js'

const execCalls: Array<{ file: string; args: string[] }> = []
let probeJson = ''
let ytdlpFails = ''
let metaDuration = '15'
const files = new Map<string, Buffer>()
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    execCalls.push({ file, args })
    if (file === 'yt-dlp' && ytdlpFails) return cb(Object.assign(new Error('yt-dlp failed'), { stderr: ytdlpFails }))
    if (file === 'ffprobe') return cb(null, { stdout: probeJson, stderr: '' })
    if (file === 'yt-dlp' && args.includes('--skip-download')) return cb(null, { stdout: `${metaDuration}\nauthor | caption text\nAs It Was\tHarry Styles\n`, stderr: '' })
    if (file === 'yt-dlp') { files.set(args[args.indexOf('-o') + 1], Buffer.from('mp4')) }
    if (file === 'ffmpeg') { files.set(args[args.length - 1], Buffer.from('mp4')) }
    cb(null, { stdout: '', stderr: '' })
  },
}))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  existsSync: vi.fn((p: string) => files.has(p)),
  readFileSync: vi.fn((p: string) => files.get(p) ?? Buffer.from('mp4')),
  writeFileSync: vi.fn((p: string, d: string | Buffer) => { files.set(p, Buffer.from(d)) }),
  renameSync: vi.fn((a: string, b: string) => { files.set(b, files.get(a) ?? Buffer.from('')); files.delete(a) }),
  unlinkSync: vi.fn((p: string) => { files.delete(p) }),
}))
vi.mock('../../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async () => ({ fileId: 'file-new', name: 'x.mp4', type: 'video/mp4', size: 3 })) }))
vi.mock('../mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async () => 'https://s3/x'), downloadToSessionCache: vi.fn(async () => ({ filePath: '/cache/s-f.mp4', buf: Buffer.from(''), mimeType: 'video/mp4' })) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const probe = (codec: string, dur: number) => JSON.stringify({ format: { duration: String(dur) }, streams: [{ codec_type: 'video', codec_name: codec, width: 720, height: 1280, r_frame_rate: '30/1' }, { codec_type: 'audio' }] })

beforeEach(() => { execCalls.length = 0; ytdlpFails = ''; metaDuration = '15'; probeJson = probe('h264', 15); files.clear(); vi.mocked(uploadGeneratedFile).mockClear() })

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
  it('flags videos over 90s as tooLong BEFORE downloading or saving anything (review I3)', async () => {
    metaDuration = '178'
    const v = await fetchVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(v.tooLong).toBe(true)
    expect(execCalls.some((c) => c.file === 'yt-dlp' && !c.args.includes('--skip-download'))).toBe(false)
    expect(uploadGeneratedFile).not.toHaveBeenCalled()
  })
  it('refuses links outside the supported platforms without fetching them (review I7)', async () => {
    await expect(fetchVideo({ url: 'http://10.0.0.5/secret.mp4' }, ctx)).rejects.toBeInstanceOf(FetchRefused)
    expect(execCalls).toEqual([])
  })
  it('ends yt-dlp options with -- so a URL can never be read as an option, and skips playlists (review I7)', async () => {
    await fetchVideo({ url: 'https://www.youtube.com/watch?v=abc&list=PL1' }, ctx)
    for (const c of execCalls.filter((x) => x.file === 'yt-dlp')) {
      expect(c.args[c.args.length - 2]).toBe('--')
      expect(c.args).toContain('--no-playlist')
    }
  })
  it('uploads the reference to Drive only once per link (review I4)', async () => {
    await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    const second = await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(uploadGeneratedFile).toHaveBeenCalledTimes(1)
    expect(second.fileId).toBe('file-new')
    expect(second.song).toEqual({ name: 'As It Was', artist: 'Harry Styles' })
  })
  it('writes the H.264 conversion to a temp name and renames it, so a killed ffmpeg never leaves a cached partial (review I5)', async () => {
    probeJson = probe('vp9', 15)
    await fetchVideo({ url: 'https://www.facebook.com/reel/1' }, ctx)
    const ff = execCalls.find((c) => c.file === 'ffmpeg')!
    expect(ff.args[ff.args.length - 1]).toMatch(/\.tmp-/)
    expect([...files.keys()].some((k) => k.endsWith('.h264.mp4'))).toBe(true)
    expect([...files.keys()].some((k) => k.includes('.tmp-'))).toBe(false)
  })
  it('turns an Instagram "not granting access" failure into a FetchRefused asking for an upload', async () => {
    ytdlpFails = 'ERROR: [Instagram] x: Instagram API is not granting access'
    await expect(fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)).rejects.toThrow(/upload/)
  })
  it('a YouTube link the server cannot download becomes DownloadBlocked carrying the link, for a watch-only breakdown', async () => {
    ytdlpFails = "ERROR: [youtube] x: Sign in to confirm you're not a bot"
    const err = await fetchVideo({ url: 'https://www.youtube.com/watch?v=abc' }, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(DownloadBlocked)
    expect(err).toBeInstanceOf(FetchRefused)
    expect(err).toMatchObject({ youtubeUrl: 'https://www.youtube.com/watch?v=abc', durationS: null })
    expect(err.message).toMatch(/upload/)
  })
  it('other platforms that fail still ask for an upload, not watch-only', async () => {
    ytdlpFails = 'ERROR: something broke'
    const err = await fetchVideo({ url: 'https://x.com/a/status/1' }, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(FetchRefused)
    expect(err).not.toBeInstanceOf(DownloadBlocked)
  })
})

describe('download failure logging (server only)', () => {
  it('logs yt-dlp\'s own error line for us, and never shows it to the user', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ytdlpFails = 'ERROR: [facebook] 123: Cannot parse data'
    const err = await fetchVideo({ url: 'https://www.facebook.com/reel/123/' }, ctx).catch((e) => e)
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/\[fetchVideo\].*facebook.*Cannot parse data/)
    expect(err.message).not.toMatch(/Cannot parse data/)
    spy.mockRestore()
  })
})

describe('links pasted without https://', () => {
  it('normalises a bare link before using it', () => {
    expect(normalizeLink('facebook.com/reel/1479672313280365/?s=ifu')).toBe('https://facebook.com/reel/1479672313280365/?s=ifu')
    expect(normalizeLink('  www.instagram.com/p/x/ ')).toBe('https://www.instagram.com/p/x/')
    expect(normalizeLink('https://x.com/a/status/1')).toBe('https://x.com/a/status/1')
    expect(classifyLink(normalizeLink('facebook.com/reel/1/'))).toBe('facebook')
  })
  it('downloads a bare link with https:// added', async () => {
    await fetchVideo({ url: 'facebook.com/reel/1479672313280365/?s=ifu' }, ctx)
    const dl = execCalls.find((c) => c.file === 'yt-dlp' && !c.args.includes('--skip-download'))!
    expect(dl.args[dl.args.length - 1]).toBe('https://facebook.com/reel/1479672313280365/?s=ifu')
  })
  it('the tools accept a bare link', async () => {
    const { fetchVideoTool } = await import('./fetchVideo.js')
    const { breakDownVideoTool } = await import('./breakDownVideo.js')
    for (const t of [fetchVideoTool, breakDownVideoTool]) expect((t.inputSchema as any).safeParse({ url: 'facebook.com/reel/1/' }).success).toBe(true)
  })
})
