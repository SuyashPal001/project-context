// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cutSignoff } from './jingleCut.js'

// ffmpeg's volumedetect writes to stderr, not stdout — execFileSync only
// returns stdout on a clean exit, so spawnSync (which exposes both streams)
// is used here to read it.
const meanVolume = (args: string[]): number => {
  const r = spawnSync('ffmpeg', ['-nostats', ...args, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  return Number(/mean_volume: (-?[0-9.]+) dB/.exec(r.stderr ?? '')?.[1] ?? NaN)
}
const stderrOf = (args: string[]): string => {
  try { execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); return '' } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? '') }
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('sign-off cut on real ffmpeg (J4)', () => {
  it('ends at the gap after the line, fades out, and is 48 kHz stereo AAC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jingle-cut-'))
    const src = join(dir, 'tone.wav')
    // 0–2.0s tone, 2.0–2.6s silence, 2.6–5.0s another tone. The "sung line"
    // is 0.5–1.8s, so the cut must stop at the gap (2.0s) and never reach
    // the next tone.
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2.4',
      '-filter_complex', '[1]atrim=0:0.6[g];[0][g][2]concat=n=3:v=0:a=1', '-ac', '1', src])

    const { audio, seconds } = await cutSignoff(src, { start: 0.5, end: 1.8, text: 'x' }, dir)
    expect(seconds).toBeCloseTo(1.65, 1)
    const out = join(dir, 'cut.m4a')
    writeFileSync(out, audio)

    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', out]).toString()
    expect(JSON.parse(probe).streams[0]).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })

    // The fade-out is present: the last 0.15s is at least 10 dB quieter than the body.
    const body = meanVolume(['-ss', '0.2', '-t', '0.5', '-i', out])
    const tail = meanVolume(['-sseof', '-0.15', '-i', out])
    expect(body - tail).toBeGreaterThanOrEqual(10)
    // And no 660 Hz tone leaked in: nothing after the cut point exists.
    expect(stderrOf(['-v', 'error', '-i', out, '-f', 'null', '-'])).toBe('')
  }, 60_000)
})
