// Snitch shot 2 opens on a selfie close-up; the image model draws a full-body walk from the guide.
// A tighter original is matched by CROPPING the kept still around the face with crop_image's own
// core (free), never by paying again (2026-10-16).
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import type { RemakeDeps } from './deps.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'
import { cropFramingFor } from './tightShots.js'

const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }), portrait: { fileId: 'portrait', img } }
const lookWith = (framing: string) => ({ ...remakeLooks(breakdown())[0], start: body({ framing: framing as never }) })
const jobFor = (framing: string): StillJob => ({ look: lookWith(framing), kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } })
function deps(stillFraming: string, o: Partial<RemakeDeps> = {}): RemakeDeps {
  return {
    ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`), upload: vi.fn(),
    generateStill: vi.fn().mockResolvedValue({ fileId: 'still-1', creditsUsedMicro: '100' }),
    poseImage: vi.fn().mockImplementation(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: body({ framing: (p.includes('crop') ? 'waist_up' : stillFraming) as never }) })),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    cropStill: vi.fn().mockResolvedValue('crop-1'),
    ...o,
  } as RemakeDeps
}

describe('a tighter original is matched by a free crop', () => {
  it('maps the reference framing to a crop only when the original is tighter', () => {
    expect(cropFramingFor('waist_up', 'full_body')).toBe('half-body')
    expect(cropFramingFor('chest_up', 'knees_up')).toBe('close-up')
    expect(cropFramingFor('face', 'waist_up')).toBe('close-up')
    expect(cropFramingFor('full_body', 'waist_up')).toBeNull()   // a wider original is never "fixed" by cropping
    expect(cropFramingFor('knees_up', 'full_body')).toBeNull()   // within one step: fine as it is
  })
  it('crops a full-body still to the selfie framing and keeps the crop, with no second paid try', async () => {
    const d = deps('full_body')
    const r = await makeStill(jobFor('waist_up'), ctx, d)
    expect(d.cropStill).toHaveBeenCalledWith('still-1', 'half-body', '9:16', expect.anything())
    expect(d.generateStill).toHaveBeenCalledTimes(1)
    expect(r.result).toMatchObject({ fileId: 'crop-1', status: 'passed' })
  })
  it('never crops when the framing already matches', async () => {
    const d = deps('waist_up')
    await makeStill(jobFor('waist_up'), ctx, d)
    expect(d.cropStill).not.toHaveBeenCalled()
  })
  it('a crop that fails keeps the uncropped still with its framing warning', async () => {
    const d = deps('full_body', { cropStill: vi.fn().mockRejectedValue(new Error('no face')) })
    const r = await makeStill(jobFor('waist_up'), ctx, d)
    expect(r.result).toMatchObject({ fileId: 'still-1', status: 'warned' })
    expect(r.result.reasons.join(' ')).toMatch(/framing/)
  })
})

// Snitch shot 1 ends with his back to the camera; our still walked toward it and passed.
describe('facing is read, said and checked', () => {
  it('the prompt says when the original has its back to the camera or is side-on', async () => {
    const { personWords } = await import('../tools/videoBreakdown/measuredLine.js')
    expect(personWords(body({ facing: 'back' } as never), null).join(', ')).toMatch(/back to the camera/)
    expect(personWords(body({ facing: 'side' } as never), null).join(', ')).toMatch(/side-on to the camera/)
    expect(personWords(body({ facing: 'front' } as never), null).join(', ')).not.toMatch(/camera/)
  })
  it('front against back is a hard fault; side-on is a warning', async () => {
    const { comparePose } = await import('./poseCompare.js')
    const back = body({ facing: 'back' } as never)
    const r = comparePose(back, 1, { people: 1, main: body({ facing: 'front' } as never) } as never)
    expect(r).toMatchObject({ status: 'fail', hard: true })
    expect(r.reason).toMatch(/back to the camera/)
    const s = comparePose(back, 1, { people: 1, main: body({ facing: 'side' } as never) } as never)
    expect(s.status).toBe('fail')
    expect(s.hard).toBeFalsy()
  })
  it('turning around within a look needs an end still', async () => {
    const { bodyChanged } = await import('./looks.js')
    expect(bodyChanged(body({ facing: 'front' } as never), body({ facing: 'back' } as never))).toBe(true)
  })
})
