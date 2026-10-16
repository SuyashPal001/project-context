// A shot longer than one clip (8s) was left as a still (Snitch shot 2: 12.4s). It is now split into
// equal continuous parts; each later part starts from the previous part's end still (no jump at the
// join, no extra paid still there).
import { describe, it, expect, vi } from 'vitest'
import { lookSpans } from '../tools/videoBreakdown/breakDownVideo.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

describe('long shots become continuous parts', () => {
  it('lookSpans splits a 12.4s shot into two equal parts', () => {
    const o = { looks: [{ label: 'run', approx_start_s: 3.4, approx_end_s: 15.8 }] } as never
    expect(lookSpans(o, [], 15.85)).toEqual([{ label: 'run', start_s: 3.4, end_s: 9.6 }, { label: 'run · part 2', start_s: 9.6, end_s: 15.8 }])
  })
  it('an 8s shot stays whole', () => {
    expect(lookSpans({ looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 8 }] } as never, [], 8)).toHaveLength(1)
  })
  const twoParts = () => {
    const b = breakdown()
    const pl = b.pose!.looks[0]
    return breakdown({
      overview: { ...b.overview, looks: [{ ...b.overview.looks[0], label: 'run', approx_start_s: 0, approx_end_s: 12 }] },
      cuts: { cuts: [], fades: [], duration_s: 12 },
      pose: { ...b.pose!, moves: [], looks: [{ ...pl, label: 'run', start_s: 0, end_s: 6 }, { ...pl, label: 'run · part 2', start_s: 6, end_s: 12 }] },
    } as never)
  }
  it('a later part continues; the part before it gets an end still', () => {
    const looks = remakeLooks(twoParts())
    expect(looks.map((l) => [l.n, l.ref, !!l.continues, l.needsEndStill])).toEqual([[1, 0, false, true], [2, 0, true, expect.any(Boolean)]])
  })
  it('the workflow reuses part 1\'s end still as part 2\'s start, without paying for it', async () => {
    const { continueParts } = await import('./workflow.js')
    const looks = remakeLooks(twoParts())
    const stills = [{ look: 1, kind: 'start' as const, fileId: 's1', status: 'passed' as const, reasons: [] }, { look: 1, kind: 'end' as const, fileId: 'e1', status: 'passed' as const, reasons: [], tries: [{ fileId: 'e1', kept: true, why: [], creditsMicro: '100' }] }]
    const out = continueParts(looks, stills)
    expect(out.find((s) => s.look === 2 && s.kind === 'start')).toEqual({ look: 2, kind: 'start', fileId: 'e1', status: 'passed', reasons: [] })
  }, 30_000)
})
void vi; void body

// Real rerun 2026-10-16 (both reels) found three of our own blocks.
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { stillGateInput, stillPrompt } from './prompts.js'
import { writePlan } from './plan.js'
import { fixLine } from './paidStill.js'
import type { RemakeDeps } from './deps.js'

const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }), portrait: { fileId: 'portrait', img } }
const okDeps = (o: Partial<RemakeDeps> = {}) => ({
  ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x'), upload: vi.fn(),
  generateStill: vi.fn().mockImplementation(async () => ({ fileId: `still-${Math.random()}`, creditsUsedMicro: '100' })),
  poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: body({ facing: 'back' } as never) }),
  promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
  stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
  ...o,
}) as unknown as RemakeDeps

describe('our own blocks found on the real rerun', () => {
  it('a still of the person from the back is never face-checked (Snitch: "the face is not visible")', async () => {
    const look = { ...remakeLooks(breakdown())[0], start: body({ facing: 'back' } as never) }
    const d = okDeps()
    await makeStill({ look, kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } } as StillJob, ctx, d)
    expect((d.stillChecks as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ leadInShot: false })
  })
  it('the prompt check is told a trick object is added later, so it is not "missing" (fan blade)', async () => {
    const b = breakdown({ overview: { ...breakdown().overview, props: [{ prop: 'remote', where: 'rug', when: 'all' }, { prop: 'fan blade', where: 'over the lens', when: 'changes', part_of_trick: true }] } as never })
    const p = await writePlan(b, { name: 'B', product: 'B' }, vi.fn().mockResolvedValue({ lines: [] }))
    const g = stillGateInput(p, p.looks[0], 'start', stillPrompt(p, p.looks[0], 'start', { name: 'B', product: 'B' }, false))
    expect(g.planLine).toMatch(/props\[1\]: keep[^;]*added over the finished video, never drawn in a still/)
  })
  it('a retry asks for the fix in plain plan words, and the check knows it is a retry', async () => {
    expect(fixLine(['the face differs from the chosen person: rounder face, different nose'])).toBe('the face must be exactly the person in the first image')
    expect(fixLine(['an object appears twice (two remotes)'])).toBe('show each object only once')
    const d = okDeps({ stillChecks: vi.fn().mockResolvedValueOnce({ passed: false, reasons: ['the face differs from the chosen person: rounder face'] }).mockResolvedValue({ passed: true, reasons: [] }) })
    const look = remakeLooks(breakdown())[0]
    await makeStill({ look, kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } } as StillJob, ctx, d)
    const second = (d.promptGate as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(second.prompt).toMatch(/^Edit the first image\. Change only this: the face must be exactly the person in the second image\./) // an edit, in plan words
    expect(second.planLine).toMatch(/edit of a still that was already checked/)
  })
})
