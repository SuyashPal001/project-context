// One real Lyria 3 call ($0.04) on the test project, then the real cut.
// Tagged: runs only with RUN_JINGLE_REAL=1. Never fitnearn-devops.
import { describe, it, expect } from 'vitest'
import { execSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findLine, parseTimedLyrics } from './timedLyrics.js'
import { cutSignoff } from './jingleCut.js'

const PROJECT = process.env.JINGLE_REAL_PROJECT ?? 'excellent-setup-486815-c1'
const ACCOUNT = process.env.JINGLE_REAL_ACCOUNT ?? 'suyashresearchwork@gmail.com'

describe.skipIf(!process.env.RUN_JINGLE_REAL)('Lyria 3 sings the sign-off and the cut lands on it (real, $0.04)', () => {
  it('finds the line, cuts 1.5–8s, and ends in silence', async () => {
    if (PROJECT === 'fitnearn-devops') throw new Error('never run generation tests on fitnearn-devops')
    const token = execSync(`gcloud auth print-access-token --account=${ACCOUNT}`).toString().trim()
    // Same body the gateway builds (lyria3Body, pinned in music.test.ts).
    const body = { contents: [{ role: 'user', parts: [{ text: 'bright pop jingle, female vocal, 120 bpm\n\nLyrics:\n[Chorus]\nEvery bubble, every sip\nBubbli, feel the magic' }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } }
    const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/lyria-3-clip-preview:generateContent`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(res.ok).toBe(true)
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> } }> }
    const parts = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((p) => p.text).map((p) => p.text).join('\n')
    const audio = parts.find((p) => p.inlineData?.data)?.inlineData?.data
    expect(audio).toBeTruthy()

    const line = findLine(parseTimedLyrics(text), 'Bubbli, feel the magic')
    expect(line, `lyrics were:\n${text}`).not.toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 'jingle-real-'))
    const full = join(dir, 'full.mp3')
    writeFileSync(full, Buffer.from(audio!, 'base64'))
    const { audio: cut, seconds } = await cutSignoff(full, line!, dir)
    const cutPath = join(dir, 'cut.m4a')
    writeFileSync(cutPath, cut)
    console.log(`[jingle-real] files to listen to: ${dir} (line ${line!.start}–${line!.end}s, cut ${seconds}s)`)
    expect(seconds).toBeGreaterThanOrEqual(1.5)
    expect(seconds).toBeLessThanOrEqual(8)

    // Ends in silence: the last 0.1s of the cut is quiet.
    let stderr = ''
    try { execFileSync('ffmpeg', ['-nostats', '-sseof', '-0.1', '-i', cutPath, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? '') }
    stderr ||= execFileSync('ffmpeg', ['-nostats', '-sseof', '-0.1', '-i', cutPath, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })?.toString() ?? ''
    const mean = Number(/mean_volume: (-?[0-9.]+) dB/.exec(stderr)?.[1] ?? NaN)
    expect(mean).toBeLessThan(-30)
  }, 180_000)
})
