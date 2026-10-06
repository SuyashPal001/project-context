// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { levelMatchJingles, loudnessProbeArgs } from './mixVoiceover.js'
import { parseIntegratedLoudness } from './mixMusicBed.js'

const lufs = (args: string[]): number => parseIntegratedLoudness(spawnSync('ffmpeg', ['-nostats', ...args], { encoding: 'utf8' }).stderr)!

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('jingle level match on real ffmpeg (J6)', () => {
  it('a jingle about 8 LU too loud comes out within ±1 LU of the target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jingle-level-'))
    const base = join(dir, 'base.wav'), jingle = join(dir, 'jingle.wav')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=10', '-af', 'volume=-20dB', base])
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000:duration=2', '-af', 'volume=-10dB', jingle])

    const windowLufs = lufs(['-ss', '1', '-t', '5', '-i', base, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'])
    const target = windowLufs + 2 // no speech in the window: base + 2 LU
    const jingleLufs = lufs(loudnessProbeArgs(jingle))
    expect(jingleLufs - target).toBeGreaterThan(6) // it really starts too loud
    expect(jingleLufs - target).toBeLessThan(11)

    const [matched] = await levelMatchJingles([base, jingle], [{ start: 6, duration: 2, kind: 'jingle' }], [jingleLufs], true)
    const after = lufs(['-i', jingle, '-af', `volume=${matched.gainDb}dB,ebur128=framelog=verbose`, '-f', 'null', '-'])
    expect(Math.abs(after - target)).toBeLessThanOrEqual(1)
  }, 60_000)
})
