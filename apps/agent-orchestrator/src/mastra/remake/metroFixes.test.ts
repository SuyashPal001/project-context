// Metro reel A/B (2026-10-16) found four faults in our own still code, on both ways of making stills:
// every prop went into every still (a phone in the selfie shots, earbuds in shot 1); a part's end still
// repeated its start pose; a still whose original faces away was never face-checked, so the original
// person's face passed; and a drawn (cartoon) still passed every check.
import { describe, it, expect, vi } from 'vitest'
import { stillPrompt, stillGateInput, propsAt } from './prompts.js'
import { writePlan } from './plan.js'
import { remakeStillChecks } from './stillChecks.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeLooks } from './looks.js'
import type { RemakeDeps } from './deps.js'
import { breakdown, body } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda' }
const props = [
  { prop: 'Flower bouquet', where: 'hand', when: 'Throughout video', stays_in_place: false, part_of_trick: false },
  { prop: 'Smartphone', where: 'hand', when: '0:00 - 0:03.5', stays_in_place: false, part_of_trick: false },
  { prop: 'Wired EarPods', where: 'ears', when: '0:03.7 - 0:14.0', stays_in_place: false, part_of_trick: false },
]

describe('a still lists only the props in view at its time', () => {
  const b = () => breakdown({ overview: { ...breakdown().overview, props } } as never)
  it('propsAt keeps a prop whose time range covers the still, and any prop with no times', () => {
    const p = { reference: { props: props.map(({ prop, where, when }) => ({ prop, where, when })) }, lines: [] } as never
    expect(propsAt(p, 1)).toEqual(['Flower bouquet', 'Smartphone'])
    expect(propsAt(p, 8)).toEqual(['Flower bouquet', 'Wired EarPods'])
  })
  it('the still prompt and its check input use the same props', async () => {
    const p = await writePlan(b(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = { ...p.looks[0], guideStartS: 8 }
    const prompt = stillPrompt(p, look, 'start', brand, false)
    expect(prompt).toMatch(/Objects: Flower bouquet; Wired EarPods\./)
    expect(stillGateInput(p, look, 'start', prompt).startFrameObjects).toEqual(['Flower bouquet', 'Wired EarPods'])
  })
})

describe('an end still never repeats the start pose', () => {
  it('a part with no end pose of its own says no pose words for its end', async () => {
    const p = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = { ...p.looks[0], startPose: 'Standing, looking into camera', endPose: '' }
    expect(stillPrompt(p, look, 'end', brand, false)).not.toMatch(/Pose: Standing, looking into camera/)
    expect(stillGateInput(p, look, 'end', 'x').look.pose).toBeFalsy()
  })
})

const img = { data: 'AA', mime: 'image/jpeg' }
const glitchFree = { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, drawn: false, what: '' }
const asker = (o: { glitch?: Record<string, unknown>; visible?: Record<string, unknown> } = {}) => vi.fn(async (parts: Array<{ text?: string }>) => {
  const q = parts.map((p) => ('text' in p ? p.text : '')).join(' ')
  if (/duplicate_object/.test(q)) return { ...glitchFree, ...o.glitch }
  if (/face_visible/.test(q)) return { face_visible: true, same_person: true, why: '', ...o.visible }
  if (/same face/.test(q)) return { lead_present: true, same_face: true, why: '' }
  return { others: [] }
})

describe('a drawn still is a hard fault', () => {
  it('a cartoon or illustration fails', async () => {
    const r = await remakeStillChecks(asker({ glitch: { drawn: true, what: 'illustration' } }) as never, img, { lead: img, leadInShot: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/not a real photo/)
  })
})

describe('a still whose original faces away is still face-checked when a face shows', () => {
  it('a visible face that differs fails', async () => {
    const r = await remakeStillChecks(asker({ visible: { same_person: false, why: 'blonde, not dark curly hair' } }) as never, img, { lead: img, faceMayHide: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/face differs/)
  })
  it('no face in view passes', async () => {
    const r = await remakeStillChecks(asker({ visible: { face_visible: false, same_person: false } }) as never, img, { lead: img, faceMayHide: true })
    expect(r.passed).toBe(true)
  })
  it('makeStill asks for it when the original shows the person from the back', async () => {
    const look = remakeLooks(breakdown())[0]
    const back = { ...look, start: { ...look.start!, facing: 'back' as const } }
    const job: StillJob = { look: back, kind: 'start', prompt: 'P', references: ['sheet', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
    const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img } }
    const stillChecks = vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: [] })
    const deps = {
      ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x.jpg'), upload: vi.fn(),
      generateStill: vi.fn().mockResolvedValue({ fileId: 'still-1', creditsUsedMicro: '100' }),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: back.start }),
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      stillChecks, ffmpeg: vi.fn(), readFile: vi.fn(), renderPreview: vi.fn(), imageRateMicro: vi.fn(),
    } as unknown as RemakeDeps
    await makeStill(job, ctx, deps)
    expect(stillChecks.mock.calls[0][2]).toMatchObject({ leadInShot: false, faceMayHide: true })
  })
})
void body
