import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseShowinfoCuts, detectCutTimes } from './detectCuts.js'

describe('parseShowinfoCuts', () => {
  it('reads every pts_time from ffmpeg showinfo output, rounded, skipping 0', () => {
    const stderr = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  1 pts_time:1.6 duration\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:  2 pts_time:3.68 x\n[x] pts_time:0\n'
    expect(parseShowinfoCuts(stderr)).toEqual([1.6, 3.68])
  })
})

// Task-4-review items 1, 3 and 5: detectCutTimes' cache is keyed by scope +
// threshold (not just videoFileId), so a Director-controlled threshold on
// detect_cuts can't poison plan_tvc's fixed-threshold lookup; it dedups
// identical calls instead of re-running ffmpeg; and it evicts a failed
// detection so a retry re-attempts it.
const manyCutsStderr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
  .map((n) => `[Parsed_showinfo_1] n: ${n} pts_time:${n}`).join('\n')
const fewCutsStderr = [1, 2].map((n) => `[Parsed_showinfo_1] n: ${n} pts_time:${n}`).join('\n')

let execFileMock: ReturnType<typeof vi.fn>
let shouldFailFfmpeg: boolean

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (globalThis as unknown as { __execFileMock: (...a: unknown[]) => void }).__execFileMock(...args),
}))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async () => 'https://example.com/video.mp4'),
  downloadToSessionCache: vi.fn(async () => ({ filePath: '/tmp/fake-reference.mp4', buf: Buffer.from(''), mimeType: 'video/mp4' })),
}))

describe('detectCutTimes caching (Task 4 review)', () => {
  beforeEach(() => {
    shouldFailFfmpeg = false
    execFileMock = vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (file === 'ffmpeg') {
        if (shouldFailFfmpeg) { cb(new Error('ffmpeg exploded')); return }
        const filterArg = args.find((a) => a.includes('showinfo')) ?? ''
        const stderr = filterArg.includes('gt(scene,0.9)') ? fewCutsStderr : manyCutsStderr
        cb(null, { stdout: '', stderr })
      } else {
        cb(null, { stdout: '15\n', stderr: '' })
      }
    });
    (globalThis as unknown as { __execFileMock: typeof execFileMock }).__execFileMock = execFileMock
  })

  it('keys the cache by threshold: a 0.9 detect_cuts call does not poison a later 0.25 lookup for the same file', async () => {
    const atHighThreshold = await detectCutTimes('ref-video', 'tok', 'tenant-a', 0.9)
    expect(atHighThreshold.cutTimes).toHaveLength(2)
    const atDefaultThreshold = await detectCutTimes('ref-video', 'tok', 'tenant-a', 0.25)
    expect(atDefaultThreshold.cutTimes).toHaveLength(13)
    // Two distinct cache entries means ffmpeg ran twice (plus ffprobe twice).
    expect(execFileMock).toHaveBeenCalledTimes(4)
  })

  it('keys the cache by tenant: the same fileId+threshold for a different tenant does not hit another tenant\'s entry', async () => {
    await detectCutTimes('shared-ref', 'tok', 'tenant-a', 0.25)
    const callsAfterFirst = execFileMock.mock.calls.length
    await detectCutTimes('shared-ref', 'tok', 'tenant-b', 0.25)
    expect(execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('dedups identical calls (same scope, file, threshold) instead of re-running ffmpeg', async () => {
    const key = `dedup-video-${Math.random()}`
    const [a, b] = await Promise.all([
      detectCutTimes(key, 'tok', 'tenant-dedup', 0.25),
      detectCutTimes(key, 'tok', 'tenant-dedup', 0.25),
    ])
    expect(a).toEqual(b)
    expect(execFileMock).toHaveBeenCalledTimes(2) // one ffmpeg + one ffprobe, not four
  })

  it('evicts a failed detection from the cache, so a retry re-attempts it', async () => {
    const key = `flaky-video-${Math.random()}`
    shouldFailFfmpeg = true
    await expect(detectCutTimes(key, 'tok', 'tenant-flaky', 0.25)).rejects.toThrow('ffmpeg exploded')
    shouldFailFfmpeg = false
    const result = await detectCutTimes(key, 'tok', 'tenant-flaky', 0.25)
    expect(result.cutTimes).toHaveLength(13)
  })
})
