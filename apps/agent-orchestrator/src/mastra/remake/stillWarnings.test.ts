// The user's split (2026-10-16): a hard fault (duplicate object, extra/missing person, stray face,
// CG effect) gets one retry; a soft doubt (text on signs, face match, framing, knees) is a warning:
// the still is kept, shown with the note, and used for the clip. No paid retry on a warning.
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeStillChecks } from './stillChecks.js'
import { usableStill } from './preview.js'
import { comparePose } from './poseCompare.js'
import type { RemakeDeps } from './deps.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

const look = remakeLooks(breakdown())[0]
const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }), portrait: { fileId: 'portrait', img } }
const okPose = { model: 'm', people: 1, no_person: false, main: look.start }
function deps(o: Partial<RemakeDeps> = {}): RemakeDeps {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x.jpg'), upload: vi.fn(),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn().mockResolvedValue(okPose),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn(), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn(), imageRateMicro: vi.fn(),
    ...o,
  } as RemakeDeps
}

describe('a warning keeps the still without paying again', () => {
  it('text on a sign: one paid call, kept as warned', async () => {
    const d = deps({ stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: ['made-up text on a sign'] }) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(1)
    expect(r.result).toMatchObject({ status: 'warned', fileId: 'still-1', reasons: ['made-up text on a sign'] })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['kept'])
  })
  it('a framing or knee difference is a warning, not a retry', async () => {
    const d = deps({ poseImage: vi.fn().mockResolvedValue({ ...okPose, main: { ...look.start!, framing: 'chest_up' } }) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(1)
    expect(r.result.status).toBe('warned')
    expect(r.result.reasons.join(' ')).toMatch(/framing/)
  })
  it('a hard fault still retries once; warnings ride along', async () => {
    const d = deps({ stillChecks: vi.fn().mockResolvedValueOnce({ passed: false, reasons: ['two remotes'], warnings: ['face may differ'] }).mockResolvedValue({ passed: true, reasons: [], warnings: ['face may differ'] }) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(2)
    expect((d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toMatch(/Fix: two remotes$/)
    expect(r.result).toMatchObject({ status: 'warned', fileId: 'still-2' })
  })
  it('an extra person is hard', () => {
    expect(comparePose(body(), 1, { people: 2, main: body() } as never).hard).toBe(true)
    expect(comparePose(body(), 1, { people: 1, main: body({ framing: 'face' }) } as never).hard).toBeFalsy()
  })
  it('a warned still is used for the preview and the clips', () => {
    expect(usableStill({ look: 1, kind: 'start', fileId: 'f', status: 'warned', reasons: ['x'] })).toBe('f')
    expect(usableStill({ look: 1, kind: 'start', fileId: 'f', status: 'failed', reasons: ['x'] })).toBeNull()
  })
})

describe('remakeStillChecks sorts each finding', () => {
  const ask = (glitch: Record<string, unknown>, face: Record<string, unknown>, others: unknown[] = []) => vi.fn(async (parts: Array<{ text?: string }>) => {
    const q = parts.map((p) => ('text' in p ? p.text : '')).join(' ')
    if (/duplicate_object/.test(q)) return { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, what: '', ...glitch }
    if (/same face/.test(q)) return { lead_present: true, same_face: true, why: '', ...face }
    return { others }
  })
  it('made-up text is a warning; a duplicate object is hard', async () => {
    const r = await remakeStillChecks(ask({ invented_text: true, duplicate_object: true, what: 'sign text; two remotes' }, {}) as never, img, { lead: img, leadInShot: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/appears twice/)
    expect(r.warnings.join(' ')).toMatch(/text/)
  })
  it('a face doubt is a warning; a clone of the lead in the background is hard', async () => {
    const r = await remakeStillChecks(ask({}, { same_face: false, why: 'nose differs' }, [{ where: 'left', looks_like_lead: true }]) as never, img, { lead: img, leadInShot: true })
    expect(r.warnings.join(' ')).toMatch(/face/i)
    expect(r.passed).toBe(false)
  })
  it('clean still: passed, no warnings', async () => {
    expect(await remakeStillChecks(ask({}, {}) as never, img, { lead: img, leadInShot: true })).toEqual({ passed: true, reasons: [], warnings: [] })
  })
})
