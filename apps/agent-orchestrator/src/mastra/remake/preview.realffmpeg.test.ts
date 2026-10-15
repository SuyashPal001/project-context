import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPreview, PREVIEW_FPS } from './preview.js'

const dir = mkdtempSync(join(tmpdir(), 'remake-preview-'))
const still = (name: string, color: string) => {
  const p = join(dir, name)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=540x960`, '-frames:v', '1', p])
  return p
}
const probe = (p: string, args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, p]).toString().trim()

it('renders exact frames, the right size and a silent audio track; grey cards fill missing stills', async () => {
  const out = await renderPreview({ workDir: dir, width: 1080, height: 1920, segments: [
    { seconds: 1.3, start: still('a.png', 'red'), end: null },
    { seconds: 2.0, start: still('b.png', 'blue'), end: still('c.png', 'green') },
    { seconds: 0.7, start: null, end: null },
  ] })
  expect(Number(probe(out, ['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0']))).toBe(Math.round(4.0 * PREVIEW_FPS))
  expect(probe(out, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])).toBe('1080,1920')
  expect(probe(out, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'])).toBe('aac')
}, 60_000)
