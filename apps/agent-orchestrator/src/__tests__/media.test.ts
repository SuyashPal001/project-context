import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile as execFileCb } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn() }
})

describe('extractVideoFrames', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns an empty array when ffmpeg fails, without throwing', async () => {
    const { extractVideoFrames } = await import('../media.js')
    const mockedExecFile = vi.mocked(execFileCb)
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void
      cb(new Error('ffmpeg not found'))
    }) as unknown as typeof execFileCb)

    const result = await extractVideoFrames('/tmp/does-not-matter.mp4', 'clip.mp4', 'session-1')
    expect(result).toEqual([])
  })

  it('reads back frame files ffmpeg produced, honoring a custom maxFrames', async () => {
    const { extractVideoFrames } = await import('../media.js')
    const mockedExecFile = vi.mocked(execFileCb)
    let frameDir = ''
    mockedExecFile.mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: Error | null, res?: { stdout: string; stderr: string }) => void
      if (cmd === 'ffprobe') {
        cb(null, { stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '10' }] }), stderr: '' })
        return
      }
      // cmd === 'ffmpeg' — args include the output pattern as the last element
      const pattern = args[args.length - 1]
      frameDir = pattern.slice(0, pattern.lastIndexOf('/'))
      writeFileSync(pattern.replace('%03d', '001'), Buffer.from('fake-jpg'))
      writeFileSync(pattern.replace('%03d', '002'), Buffer.from('fake-jpg'))
      cb(null, { stdout: '', stderr: '' })
    }) as unknown as typeof execFileCb)

    const result = await extractVideoFrames('/tmp/does-not-matter.mp4', 'clip.mp4', 'session-1', 2)
    expect(result).toHaveLength(2)
    expect(result[0].mimeType).toBe('image/jpeg')
    expect(result[0].name).toBe('clip.mp4_frame1.jpg')
  })
})
