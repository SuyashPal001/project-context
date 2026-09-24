import { describe, it, expect } from 'vitest'
import { buildStretchArgs, inputSchema } from './stretchClip.js'

const base = { sourcePath: '/tmp/in.mp4', outputPath: '/tmp/out.mp4', hasAudio: true }

function args(mode: 'loop' | 'slow' | 'hold', sourceSeconds: number, targetSeconds: number, hasAudio = true) {
  return buildStretchArgs({ ...base, mode, sourceSeconds, targetSeconds, hasAudio })
}

describe('buildStretchArgs', () => {
  it('refuses a target that is not longer than the source', () => {
    expect(args('loop', 8, 8)).toEqual({ ok: false, reason: 'TARGET_NOT_LONGER' })
    expect(args('hold', 8, 5)).toEqual({ ok: false, reason: 'TARGET_NOT_LONGER' })
  })

  it('loop repeats the input and trims to the exact target, audio included', () => {
    const r = args('loop', 4, 10)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args.slice(0, 5)).toEqual(['-y', '-stream_loop', '-1', '-i', '/tmp/in.mp4'])
    expect(r.args[r.args.indexOf('-t') + 1]).toBe('10.000')
    expect(r.args).toContain('aac')
    expect(r.args).not.toContain('-an')
    expect(r.args[r.args.length - 1]).toBe('/tmp/out.mp4')
  })

  it('loop refuses an extreme repeat ratio', () => {
    expect(args('loop', 1, 31)).toEqual({ ok: false, reason: 'STRETCH_TOO_LARGE' })
    expect(args('loop', 1, 30).ok).toBe(true)
  })

  it('slow computes setpts factor and the inverse atempo', () => {
    const r = args('slow', 5, 8)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args[r.args.indexOf('-vf') + 1]).toBe('setpts=1.600000*PTS')
    expect(r.args[r.args.indexOf('-af') + 1]).toBe('atempo=0.625000')
  })

  it('slow refuses beyond 2x but allows exactly 2x', () => {
    expect(args('slow', 5, 10.01)).toEqual({ ok: false, reason: 'STRETCH_TOO_LARGE' })
    expect(args('slow', 5, 10).ok).toBe(true)
  })

  it('hold pads by the full target and lets -t trim, silencing audio after the original', () => {
    const r = args('hold', 6, 9.5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args[r.args.indexOf('-vf') + 1]).toBe('tpad=stop_mode=clone:stop_duration=9.500')
    expect(r.args[r.args.indexOf('-t') + 1]).toBe('9.500')
    expect(r.args[r.args.indexOf('-af') + 1]).toBe('apad')
  })

  it('drops audio arguments when the source has no audio stream', () => {
    for (const mode of ['loop', 'slow', 'hold'] as const) {
      const r = args(mode, 4, 6, false)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.args).toContain('-an')
      expect(r.args).not.toContain('-af')
      expect(r.args).not.toContain('aac')
    }
  })

  it('only ever puts numbers into filter arguments', () => {
    const r = args('slow', 3.3, 5.1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args[r.args.indexOf('-vf') + 1]).toMatch(/^setpts=[0-9.]+\*PTS$/)
    expect(r.args[r.args.indexOf('-af') + 1]).toMatch(/^atempo=[0-9.]+$/)
  })
})

describe('stretch_clip inputSchema', () => {
  it('accepts a valid request', () => {
    expect(inputSchema.safeParse({ videoFileId: 'f1', targetDurationSeconds: 30, mode: 'loop' }).success).toBe(true)
  })

  it('rejects a non-positive, oversized, or unknown-mode request', () => {
    expect(inputSchema.safeParse({ videoFileId: 'f1', targetDurationSeconds: 0, mode: 'loop' }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'f1', targetDurationSeconds: 121, mode: 'loop' }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'f1', targetDurationSeconds: 30, mode: 'bounce' }).success).toBe(false)
  })
})
