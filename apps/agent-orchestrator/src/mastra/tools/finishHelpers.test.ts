import { describe, it, expect, vi } from 'vitest'
const calls: string[][] = []
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    calls.push([cmd, ...args])
    if (cmd === 'ffprobe') return cb(null, { stdout: args.includes('/tmp/long.wav') ? '9.0\n' : '2.0\n', stderr: '' })
    const quiet = args.includes('/tmp/quiet.wav') || args.includes('/tmp/quietbed.wav')
    return cb(null, { stdout: '', stderr: `Integrated loudness:\n    I:         ${quiet ? '-60.0' : '-20.0'} LUFS\n` })
  },
}))
import { timeVoiceoverBlocks } from './mixVoiceover.js'
import { bedLoudness, MIN_ACCEPTABLE_BED_LUFS } from './mixMusicBed.js'
import { endCardMarks } from './compositeEndCard.js'

describe('timeVoiceoverBlocks (shared by mix_voiceover and render_animatic)', () => {
  it('measures, spaces and checks the blocks', async () => {
    const out = await timeVoiceoverBlocks(['/tmp/a.wav', '/tmp/b.wav'], [{ startSeconds: 0.5 }, { startSeconds: 1.5 }], 15)
    expect('timed' in out && out.timed.map((b) => b.duration)).toEqual([2, 2])
    expect('timed' in out && out.timed[1].start).toBeGreaterThanOrEqual(2.5)
  })
  it('refuses a quiet block and a voiceover that cannot fit', async () => {
    expect(await timeVoiceoverBlocks(['/tmp/quiet.wav'], [{ startSeconds: 0 }], 15)).toEqual({ refusalReason: 'VOICEOVER_INAUDIBLE' })
    expect(await timeVoiceoverBlocks(['/tmp/long.wav'], [{ startSeconds: 0 }], 6)).toEqual({ refusalReason: 'VOICEOVER_TOO_LONG' })
  })
})

describe('bedLoudness', () => {
  it('measures the bed alone at the bed level', async () => {
    expect(await bedLoudness('/tmp/bed.wav')).toBe(-20)
    expect((await bedLoudness('/tmp/quietbed.wav'))! < MIN_ACCEPTABLE_BED_LUFS).toBe(true)
    expect(calls.some((c) => c.join(' ').includes('volume=0.35,ebur128=framelog=verbose'))).toBe(true)
  })
})

describe('endCardMarks', () => {
  it('no logo and no veg mark means no marks', () => {
    expect(endCardMarks({ width: 1920, height: 1080 }, undefined, undefined, undefined, [], 4.5, 6)).toBeUndefined()
  })
  it('a logo gets a size and a rect; a veg mark gets a rect', () => {
    const m = endCardMarks({ width: 1920, height: 1080 }, { width: 400, height: 200, transparent: true }, 'veg', 1, [], 4.5, 6)!
    expect(m.logoInput).toBe('[2:v]')
    expect(m.logo?.plated).toBe(false)
    expect(m.veg?.kind).toBe('veg')
  })
})
