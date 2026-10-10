// Real ffmpeg + libass, not mocked. Runs only with RUN_REAL_FFMPEG=1; skips without libass.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderAnimaticPasses } from './renderAnimatic.js'
import { segmentFrames, withRoughCutLabel } from './animatic.js'
import { buildAss } from './overlayText.js'

const hasLibass = () => /\bsubtitles\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '')
const run = process.env.RUN_REAL_FFMPEG && hasLibass() ? describe : describe.skip

run('render_animatic passes on real ffmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'animatic-real-'))
  const img = (name: string, size: string, color: string) => { const p = join(dir, name); execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', p]); return p }
  const tone = (name: string, secs: number, hz: number) => { const p = join(dir, name); execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`, p]); return p }
  const job = (workDir: string, voPaths: string[]) => ({
    workDir, width: 1080, height: 1920, lengthSeconds: 6, frames: segmentFrames([2, 1.5, 2.5]),
    zooms: [[1, 1.04], [1, 1.04], [1, 1.04]] as Array<[number, number]>,
    stillPaths: [img('a.png', '800x600', 'red'), img('b.png', '1080x1920', 'green'), img('c.png', '1920x1080', 'blue')],
    photoPath: img('photo.png', '600x600', 'white'),
    ass: withRoughCutLabel(buildAss([{ text: 'Ice cold', startSeconds: 0, endSeconds: 2, position: 'top' as const, size: 'medium' as const }]), 6),
    voPaths, timed: voPaths.length ? [{ start: 0.3, duration: 1.5 }] : [], blockLufs: voPaths.length ? [-20] : [], bedPath: tone('bed.wav', 6, 220),
  })
  const probe = (p: string, entries: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...entries.split(' '), '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim()

  it('renders exactly 6s at 24fps from stills of different sizes, and the zoom moves', async () => {
    const out = await renderAnimaticPasses(job(mkdtempSync(join(dir, 'w1-')), [tone('vo.wav', 1.5, 440)]))
    expect(parseInt(probe(out, '-count_packets -show_entries stream=nb_read_packets'), 10)).toBe(144)
    expect(probe(out, '-show_entries stream=width,height')).toBe('1080,1920')
    const frame = (t: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', t, '-i', out, '-frames:v', '1', '-vf', 'crop=200:200:0:0,scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    expect(Buffer.compare(frame('0.1'), frame('1.9'))).not.toBe(0)
  }, 300_000)
  it('renders a music-only ad on its silent base', async () => {
    const out = await renderAnimaticPasses(job(mkdtempSync(join(dir, 'w2-')), []))
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim()
    expect(audio.length).toBeGreaterThan(0)
  }, 300_000)
})
