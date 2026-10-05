// Real gemini-2.5-pro on the 2026-10-05 failing and passing clips. Tagged:
// runs only with RUN_TVC_REGRESSION=1 (needs gcloud access to the project).
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runNarrowClipChecks, sampleFrames, type AskFn, type Img } from './tvcChecks.js'

const FIX = join(__dirname, '../../../test-fixtures/tvc')
const PROJECT = process.env.TVC_REGRESSION_PROJECT ?? 'excellent-setup-486815-c1'
const ACCOUNT = process.env.TVC_REGRESSION_ACCOUNT ?? 'suyashresearchwork@gmail.com'
const jpg = (f: string): Img => ({ data: readFileSync(join(FIX, f)).toString('base64'), mime: 'image/jpeg' })
const duration = (f: string) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${join(FIX, f)}`).toString())

// Vertex directly (no gateway needed): same model, same JSON contract.
const vertexAsk: AskFn = async (parts) => {
  const token = execSync(`gcloud auth print-access-token --account=${ACCOUNT}`).toString().trim()
  const body = { contents: [{ role: 'user', parts: parts.map((p) => ('text' in p ? { text: p.text } : { inlineData: { mimeType: p.image.mime, data: p.image.data } })) }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }
  const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-pro:generateContent`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const v = JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
  return Array.isArray(v) ? v[0] : v
}

describe.skipIf(!process.env.RUN_TVC_REGRESSION)('TVC checks on real clips (gemini-2.5-pro)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvc-reg-'))
  const sampler = (f: string) => (times: number[]) => sampleFrames(join(FIX, f), times, dir)

  it('C7: the opener whose cap stays on fails ACTION_NOT_COMPLETED', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('cap-stays-on.mp4'), { duration: duration('cap-stays-on.mp4'), action: 'the crown cap pops off the bottle on the wall opener', endState: 'the bottle has no cap on it' })
    expect(r.passed).toBe(false)
    expect(r.endStateTrue).toBe(false)
  }, 300_000)

  it('C6: the wide shot with a lookalike extra fails LEAD_CLONED', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('lookalike-extra.mp4'), { duration: duration('lookalike-extra.mp4'), lead: jpg('lead.jpg') })
    expect(r.leadClone).toBe(true)
    expect(r.passed).toBe(false)
  }, 300_000)

  it('C7: the single-shot pop passes with the action located', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('single-shot-pop.mp4'), { duration: duration('single-shot-pop.mp4'), action: 'the crown cap pops off the bottle on the wall opener', endState: 'the bottle has no cap on it', shotDurationSeconds: 0.88 })
    expect(r.endStateTrue).toBe(true)
    expect(r.actionTime).not.toBeNull()
    expect(r.trimStartSeconds).toBeGreaterThanOrEqual(0)
  }, 300_000)

  it('C7(d): the v5 ending whose spin turns back mid-way fails as a motion reversal', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('spin-reverses.mp4'), { duration: duration('spin-reverses.mp4'), action: 'she spins all the way around in one direction, 360 degrees', endState: 'she is facing the camera again, holding the bottle' })
    expect(r.motionReversed).toBe(true)
    expect(r.passed).toBe(false)
  }, 300_000)
})
