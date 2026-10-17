// Same camera as the original (2026-10-17): a still whose person sits much bigger, smaller or shifted
// against the original's frame fails and is fixed by an edit toward the original's framing.
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeLooks } from './looks.js'
import type { RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })
const look = remakeLooks(breakdown())[0]
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img: img('P') } }
const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['sheet', 'guide-1'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, guide: 'guide-1' }
function deps(boxes: Record<string, number[] | undefined>, heads: Record<string, boolean> = {}) {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn(async (id: string) => img(id)), localFile: vi.fn(async (id: string) => id), upload: vi.fn(),
    generateStill: vi.fn(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: look.start, box: boxes[p], ...(p in heads ? { head_seen: heads[p] } : {}) })),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: [] }),
  } as unknown as RemakeDeps
}

describe('a still keeps the original camera framing', () => {
  it('a much closer camera fails and is fixed by an edit toward the original framing', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.1, 0.02, 0.9, 0.98], 'still-2': [0.3, 0.2, 0.7, 0.81] })
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('passed')
    const edit = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(edit.prompt).toMatch(/the camera framing must match the original frame/)
    // the fix changes the framing, so the edit never also says to keep it (the prompt check stopped every
    // such retry as a contradiction, fan run real7)
    expect(edit.prompt).not.toMatch(/Keep everything else exactly:[^.]*framing/)
    // the original's frame shows its own person and whatever covers them: only its framing is taken (a
    // retry copied the fan blade over her face, fan run real8)
    expect(edit.prompt).toMatch(/take nothing else from it/)
    expect(r.result.tries?.[0].why.join(' ')).toMatch(/the camera is closer/)
  })
  it('the same framing passes on the first try', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.31, 0.21, 0.69, 0.8] })
    expect((await makeStill(job, ctx, d)).result.status).toBe('passed')
    expect(d.generateStill).toHaveBeenCalledTimes(1)
  })
  it('a framing that can\'t be measured is a warning, not a pass in silence', async () => {
    const d = deps({ 'guide-1': undefined, 'still-1': [0.3, 0.2, 0.7, 0.8] })
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('warned')
    expect(r.result.reasons.join(' ')).toMatch(/framing could not be compared/)
  })
  it('a head hidden in the original (a blade in front) is a warning, not "the camera is closer"', async () => {
    const d = deps({ 'guide-1': [0.03, 0.31, 1, 0.985], 'still-1': [0.07, 0.16, 1, 0.998] }, { 'guide-1': false, 'still-1': true })
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('warned')
    expect(r.result.reasons.join(' ')).toMatch(/partly hidden/)
    expect(d.generateStill).toHaveBeenCalledTimes(1)
  })
})

describe('an object the original frame shows is in the photo', () => {
  it('a missing remote fails and is fixed by an edit that adds it where the original frame has it', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.3, 0.2, 0.7, 0.8], 'still-2': [0.3, 0.2, 0.7, 0.8] })
    let n = 0
    ;(d as { ask: unknown }).ask = () => vi.fn(async (parts: Array<{ image?: { data: string } }>) => ({ counts: { 'TV remote': parts[0].image!.data === 'guide-1' ? 1 : parts[0].image!.data === 'still-1' ? 0 : 1 }, n: n++ }))
    const r = await makeStill({ ...job, props: ['TV remote'] }, ctx, d)
    expect(r.result.tries?.[0].why.join(' ')).toMatch(/missing from the photo: TV remote/)
    const edit = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(edit.prompt).toMatch(/add the missing objects where they lie in the original frame \(image \d\); take nothing else from it/)
    expect(edit.referenceFileIds).toContain('guide-1')
    expect(r.result.status).toBe('passed')
  })
})

// Fan run real14: look 2's photo copied the original frame at 6.3s (arm behind her head) and was warned
// "right arm raised, not in the reference": the check compared it with the look's first second, before she
// raised it. A photo is checked against the frame it was drawn from, when that frame shows her well.
describe('the pose is checked against the frame the photo copies', () => {
  const armUp = { ...look.start!, arms: { left: 'down', right: 'raised' } }
  const armsDown = { ...look, start: { ...look.start!, arms: { left: 'down', right: 'down' } } }
  it('the frame\'s own pose is the reference when she is well seen in it', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.3, 0.2, 0.7, 0.8] })
    ;(d as { poseImage: unknown }).poseImage = vi.fn(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: armUp, box: [0.3, 0.2, 0.7, 0.8], head_seen: true, p }))
    const r = await makeStill({ ...job, look: armsDown as never }, ctx, d)
    expect(r.result.reasons.join(' ')).not.toMatch(/arm/)
  })
  it('a frame where she is covered falls back to the look\'s measured pose', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.3, 0.2, 0.7, 0.8] })
    ;(d as { poseImage: unknown }).poseImage = vi.fn(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: armUp, box: [0.3, 0.2, 0.7, 0.8], head_seen: p !== 'guide-1' }))
    const r = await makeStill({ ...job, look: armsDown as never }, ctx, d)
    expect(r.result.reasons.join(' ')).toMatch(/right arm/)
  })
})

describe('an edit adds nothing it was not asked for', () => {
  it('a blade copied into an edited photo fails and is fixed by an edit that removes it', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.3, 0.2, 0.7, 0.8], 'still-2': [0.3, 0.2, 0.7, 0.8] })
    ;(d as { ask: unknown }).ask = () => vi.fn(async (parts: Array<{ image?: { data: string }; text?: string }>) => {
      if (!/Image A is a photo before an edit/.test(parts.at(-1)!.text ?? '')) return {}
      return parts[3].image!.data === 'still-1' ? { added: true, what: 'a dark fan blade across the top' } : { added: false, what: '' }
    })
    const r = await makeStill({ ...job, references: ['base', 'guide-1'], faceRef: 'base', editOf: { fileId: 'base', change: 'the body pose' } }, ctx, d)
    expect(r.result.tries?.[0].why.join(' ')).toMatch(/not in the photo it was edited from: a dark fan blade across the top/)
    expect((d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toMatch(/Change only this: remove a dark fan blade across the top; the photo it was edited from has none of it/)
    expect(r.result.status).toBe('passed')
  })
})
