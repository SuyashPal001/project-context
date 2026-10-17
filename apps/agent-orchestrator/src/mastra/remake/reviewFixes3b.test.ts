// Final-review fixes for 3b (Opus review of video-phase3b): each test reproduces one finding.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown, body } from './fixtures.testing.js'
import { writePlan } from './plan.js'
import { clipSpecs, clipPrompt } from './clipSpec.js'
import { makeClip, type ClipCtx } from './paidClip.js'
import { checkClip } from './clipCheck.js'
import { differenceNote } from './finalNote.js'
import { remakeLooks } from './looks.js'
import { shapeRun } from './remakeVideoTool.js'
import type { LedgerEntry, StillResult } from './types.js'

const brand = { name: 'B', product: 'p' }
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
const ok = (look: number, kind: 'start' | 'end'): StillResult => ({ look, kind, fileId: `${look}${kind}`, status: 'passed', reasons: [] })

describe('C1 a Veo clip is retimed to the look, never cut before its end frame', () => {
  it('picks the Veo length nearest the look (4.1s → 4s, not 6s) and scales the move times in the prompt', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    // Veo serves looks with no person (a person is Omni from the start photo, v12's way); moves said in words reach it
    plan.looks = plan.looks.map((l) => ({ ...l, people: 0 }))
    plan.looks[1] = { ...plan.looks[1], startS: 4.1, endS: 8.2, moveLines: ['at 1.2s: arm/hand: lifts the can (up)'] } // 4.1s with an end still
    const [, b] = clipSpecs(plan, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(b).toMatchObject({ engine: 'veo', seconds: 4 })
    const p = clipPrompt(plan, plan.looks[1], brand, 'veo', 4) // look-relative 1.2s → 1.2 × 4/4.1
    expect(p).toMatch(/at 1\.2s: arm\/hand/)
    const p8 = clipPrompt(plan, plan.looks[1], brand, 'veo', 8)
    expect(p8).toMatch(/at 2\.3s: arm\/hand/)
  })
})

function clipDeps(o: Partial<RemakeDeps> = {}) {
  let n = 0
  return {
    promptGate: vi.fn(async () => pass),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '80' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    fitToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    ...o,
  } as unknown as RemakeDeps
}
async function clipSetup(o: Partial<RemakeDeps> = {}) {
  const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
  const specs = clipSpecs(plan, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
  const check = vi.fn(async () => pass)
  const ctx: ClipCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null, plan, brand, size: { width: 720, height: 1280 }, workDir: '/tmp/x', check }
  return { specs, deps: clipDeps(o), ctx, check }
}

describe('C2 paid attempts never drop out of the ledger', () => {
  it('a download failing after the paid retry keeps both entries and the first usable clip', async () => {
    const localFile = vi.fn().mockResolvedValueOnce('/m/omni-1').mockRejectedValueOnce(new Error('presign 500'))
    const { specs, deps, ctx, check } = await clipSetup({ localFile } as never)
    check.mockResolvedValueOnce({ ...pass, status: 'fail', reason: 'end pose: knees bent' } as never)
    const ledger: LedgerEntry[] = []
    const r = await makeClip(specs[0], ctx, deps, ledger)
    expect(ledger.map((e) => [e.outcome, e.creditsMicro])).toEqual([['retried', '100'], ['failed', '100']])
    expect(r.result).toMatchObject({ status: 'failed', fileId: 'omni-1', localPath: expect.stringContaining('look-1-a0') })
    expect(r.result.reasons.join(' ')).not.toMatch(/presign/)
  })
  it('a throw after a paid attempt still leaves that attempt in the caller-owned ledger', async () => {
    const gate = vi.fn().mockResolvedValueOnce(pass).mockRejectedValueOnce(new Error('boom'))
    const { specs, deps, ctx, check } = await clipSetup({ promptGate: gate } as never)
    check.mockResolvedValueOnce({ ...pass, status: 'fail', reason: 'x' } as never)
    const ledger: LedgerEntry[] = []
    await expect(makeClip(specs[0], ctx, deps, ledger)).rejects.toThrow('boom')
    expect(ledger).toEqual([{ item: 'look 1 clip', attempt: 0, creditsMicro: '100', outcome: 'retried' }])
  })
})

describe('I4 an Omni clip is not held to an end pose it was never given', () => {
  it('skips the end-pose comparison when asked', async () => {
    const look = remakeLooks(breakdown())[1] // end: knees straight
    const pose = { model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people: 1, people_max: 1, no_person: false, main_start: body({ knees: 'bent' }), main_end: body({ knees: 'bent' }), leg_side_start: 'center' as const, leg_side_end: 'center' as const, body_angle_end: 0, key_frames: [] }] }
    const d = { poseClip: vi.fn(async () => pose), sample: vi.fn(async () => []), gate: vi.fn(async (_s: unknown, name: string) => ({ ...pass, name })) }
    expect((await checkClip({ clipPath: '/c', seconds: 6, look, portrait: null, tenantId: 't', checkEnd: false }, d as never)).status).toBe('pass')
    expect((await checkClip({ clipPath: '/c', seconds: 6, look, portrait: null, tenantId: 't', checkEnd: true }, d as never)).status).toBe('fail')
  })
})

describe('I3 the note only claims music that was made', () => {
  it('no music line when the music failed', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    expect(differenceNote({ plan, stills: [], clips: [], checks: [], musicMade: false })).not.toMatch(/New music/)
    expect(differenceNote({ plan, stills: [], clips: [], checks: [], musicMade: true })).toMatch(/New music/)
  })
})

describe('I2 a finish with no final video shows the paid clips', () => {
  it('shapes final_failed with the clips, note and summary', () => {
    const summary = { spentMicro: '1000000', wastedMicro: '0', failed: [], blocked: [] }
    expect(shapeRun('r', { status: 'success', result: { finalFileId: null, stopped: false, previewFileId: 'p', note: 'N', clips: [{ look: 1, fileId: 'c1' }], summary } }))
      .toMatchObject({ success: false, stage: 'final_failed', clips: [{ look: 1, fileId: 'c1' }], note: 'N', summary: { spentCredits: '1.00' } })
    expect(shapeRun('r', { status: 'success', result: { finalFileId: null, stopped: true, previewFileId: 'p', note: '', stills: [], summary } }))
      .toMatchObject({ success: true, stage: 'preview_ready' })
  })
})

// I1: workflow-level — music and still-file failures never throw away the finished video.
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); return r }
const sameBody = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }
function wfDeps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  const main = breakdown().pose!.looks[0].main_start
  let n = 0
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '10' })),
    fetchImage: vi.fn(async () => ({ data: 'AA', mime: 'image/jpeg' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn(async () => ({ model: 'm', people: 1, no_person: false, main })),
    promptGate: vi.fn(async () => pass), stillChecks: vi.fn(async () => ({ passed: true, reasons: [] })),
    ffmpeg: vi.fn(async () => undefined), readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn(async () => '/m/preview.mp4'), imageRateMicro: vi.fn(async () => 10n),
    clipRateMicro: vi.fn(async () => 100n), musicRateMicro: vi.fn(async () => 8n),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '80' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    fitToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    poseClip: vi.fn(async () => ({ model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people: 1, people_max: 1, no_person: false, main_start: main, main_end: main, leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [] }] })),
    sample: vi.fn(async () => [{ data: 'AA', mime: 'image/jpeg' }]),
    generateMusic: vi.fn(async () => ({ fileId: 'music-1', creditsUsedMicro: '8' })),
    compare: vi.fn(async () => ({ checks: [pass], summary: 'ok' })),
    stillToFrames: vi.fn(async (_s: string | null, _f: number, out: string) => out),
    joinSegments: vi.fn(async (_p: string[], out: string) => out),
    fitMusic: vi.fn(async (_m: string, _s: number, out: string) => out),
    muxMusic: vi.fn(async (_v: string, _m: string, out: string) => out),
    ...o,
  } as Partial<RemakeDeps>
}
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const resume = async (id: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId: id })).resume({ step, resumeData: data, requestContext: rc() })
async function finalRun(o: Partial<RemakeDeps>, b = sameBody()) {
  setRemakeDeps(wfDeps(o))
  const run = await (await wf()).w.createRun()
  await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
  await resume(run.runId, 'plan', { decision: 'approve' })
  await resume(run.runId, 'cast', { pick: 1 })
  return ((await resume(run.runId, 'preview', { decision: 'approve' })) as unknown as { result: { finalFileId: string | null; note: string } }).result
}
describe('I1 music or a still file failing never throws away the finished video', () => {
  beforeEach(() => setRemakeStorageForTests(new InMemoryStore()))
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  it('the music call throwing delivers the video silent', async () => {
    const out = await finalRun({ generateMusic: vi.fn(async () => { throw new Error('ledger db down') }) } as never)
    expect(out.finalFileId).toBeTruthy()
    expect(out.note).toMatch(/silent/)
    expect(out.note).not.toMatch(/New music/)
  })
  it('the music mix failing delivers the video silent', async () => {
    const out = await finalRun({ muxMusic: vi.fn(async () => { throw new Error('ffmpeg') }) } as never)
    expect(out.finalFileId).toBeTruthy()
    expect(out.note).toMatch(/silent/)
  })
  it('a still that cannot be fetched becomes a grey card, the video is still delivered', async () => {
    const b = sameBody(); b.overview.looks[1] = { ...b.overview.looks[1], moves: [] }
    // Still files become unreachable only once the clips step has run (the casting sheet is an img- file too).
    let clipsStarted = false
    const noCredits = vi.fn(async () => { clipsStarted = true; return { insufficientCredits: true } })
    const localFile = vi.fn(async (id: string) => { if (clipsStarted && id.startsWith('img-')) throw new Error('presign'); return `/m/${id}` })
    const stillToFrames = vi.fn(async (_s: string | null, _f: number, out: string) => out)
    // Part 1 gets a real clip; part 2 has no clip and an unreachable still → grey card. A video
    // with at least one real part is delivered (an all-grey one is not: gateInputs.test.ts).
    const omni = vi.fn(async () => ({ fileId: 'omni-1', creditsUsedMicro: '100' }))
    const out = await finalRun({ localFile, stillToFrames, generateOmniClip: omni, generateVeoClip: noCredits } as never, b)
    expect(stillToFrames.mock.calls.every((c) => c[0] === null)).toBe(true) // grey cards
    expect(out.finalFileId).toBeTruthy()
  })
})

// The fan reel's trick (2026-10-17): the looks are joined with v12's fan wipe, timed from the original, whenever
// the original's trick is a fan or blade wipe at measured hidden cuts. Anything going wrong falls back to cuts.
const fanBody = () => {
  const b = sameBody()
  b.overview.trick = 'a ceiling fan blade sweeps across the lens and hides each outfit change'
  b.overview.props = [...b.overview.props, { prop: 'Ceiling fan blade', where: 'over the lens', when: 'at each change', part_of_trick: true }]
  b.hidden_cuts = [{ from: b.overview.looks[0].label, to: b.overview.looks[1].label, at_s: 5, covered_s: [4.5, 5.5] }]
  return b
}
describe('the fan wipe joins the looks', () => {
  beforeEach(() => setRemakeStorageForTests(new InMemoryStore()))
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  it('the plan notes a fan wipe with its measured covered spans; other tricks get none', async () => {
    const ask = vi.fn().mockResolvedValue({ lines: [] })
    expect((await writePlan(fanBody(), brand, ask)).reference.wipe).toEqual({ kind: 'fan', covered: [[4.5, 5.5]] })
    const plain = sameBody(); plain.overview.trick = 'a hand wipe'
    expect((await writePlan(plain, brand, ask)).reference.wipe).toBeUndefined()
  })
  it('the final video is joined with the fan from the original', async () => {
    const fanSweep = vi.fn(async (i: { out: string }) => i.out)
    const joinSegments = vi.fn(async (_p: string[], out: string) => out)
    const out = await finalRun({ fanSweep, joinSegments } as never, fanBody())
    expect(out.finalFileId).toBeTruthy()
    expect(fanSweep).toHaveBeenCalledTimes(1)
    const arg = fanSweep.mock.calls[0][0] as unknown as { original: string; segments: string[]; counts: number[]; covered: number[][] }
    expect(arg.original).toBe('/m/vid')
    expect(arg.segments).toHaveLength(2)
    expect(arg.counts.reduce((x, y) => x + y, 0)).toBeGreaterThan(0)
    expect(arg.covered).toEqual([[4.5, 5.5]])
    expect(joinSegments).not.toHaveBeenCalled()
  })
  it('a fan that fails falls back to plain cuts and the video is still delivered', async () => {
    const joinSegments = vi.fn(async (_p: string[], out: string) => out)
    const out = await finalRun({ fanSweep: vi.fn(async () => { throw new Error('ai-service down') }), joinSegments } as never, fanBody())
    expect(out.finalFileId).toBeTruthy()
    expect(joinSegments).toHaveBeenCalledTimes(1)
  })
})
