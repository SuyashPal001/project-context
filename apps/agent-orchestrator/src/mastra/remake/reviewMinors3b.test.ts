// The deferred minors from the 3b review (M2, M4–M12), each pinned by a test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'
import { writePlan } from './plan.js'
import { clipSpecs } from './clipSpec.js'
import { makeClip, clipSlot, type ClipCtx } from './paidClip.js'
import { checkClip } from './clipCheck.js'
import { differenceNote } from './finalNote.js'
import { remakeLooks } from './looks.js'
import type { StillResult } from './types.js'

vi.mock('../tools/generationApproval.js', async (orig) => ({ ...(await orig<typeof import('../tools/generationApproval.js')>()), shouldRequireApproval: vi.fn(async (o: { subject: string }) => o.subject.includes('omni')) }))
const { remakeVideoTool } = await import('./remakeVideoTool.js')

const brand = { name: 'B', product: 'p' }
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
const ok = (look: number, kind: 'start' | 'end'): StillResult => ({ look, kind, fileId: `${look}${kind}`, status: 'passed', reasons: [] })
const rc = (o: Record<string, string> = {}) => { const r = new RequestContext(); for (const [k, v] of Object.entries({ tenantId: 't1', idToken: 'tok', conversationId: 'c1', sessionId: 's1', ...o })) r.set(k, v); return r }

async function clipSetup(o: Partial<RemakeDeps> = {}) {
  const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
  plan.looks = plan.looks.map((l) => ({ ...l, people: 0 }))   // Veo's mechanics: looks with no person (a person is Omni)
  const specs = clipSpecs(plan, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
  let n = 0
  const deps = {
    promptGate: vi.fn(async () => pass),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '80' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    fitToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    ...o,
  } as unknown as RemakeDeps
  const check = vi.fn(async () => pass)
  const ctx: ClipCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null, plan, brand, size: { width: 720, height: 1280 }, workDir: '/tmp/x', check }
  return { specs, deps, ctx, check }
}

describe('M12 a Veo content block is retried once with plainer wording before switching models', () => {
  it('blocked → plainer Veo prompt (free: blocked clips are not charged) → only then Omni', async () => {
    const veo = vi.fn().mockResolvedValueOnce({ refused: true, refusalReason: 'CONTENT_BLOCKED' }).mockResolvedValueOnce({ fileId: 'veo-plain', creditsUsedMicro: '80' })
    const { specs, deps, ctx } = await clipSetup({ generateVeoClip: veo } as never)
    const r = await makeClip(specs[1], ctx, deps)
    expect(veo).toHaveBeenCalledTimes(2)
    const [first, plain] = veo.mock.calls.map((c) => c[0].prompt as string)
    expect(plain.length).toBeLessThanOrEqual(first.length)   // a look with no person has no person lines to drop
    expect(plain).not.toMatch(/Expression:|At the start:/)
    expect(plain).toMatch(/first frame/)
    expect(deps.generateOmniClip).not.toHaveBeenCalled()
    expect(r.result).toMatchObject({ engine: 'veo', fallback: false, status: 'passed', fileId: 'veo-plain' })
  })
  it('blocked twice → one Omni attempt', async () => {
    const veo = vi.fn(async () => ({ refused: true, refusalReason: 'CONTENT_BLOCKED' }))
    const { specs, deps, ctx } = await clipSetup({ generateVeoClip: veo } as never)
    const r = await makeClip(specs[1], ctx, deps)
    expect(veo).toHaveBeenCalledTimes(2)
    expect(deps.generateOmniClip).toHaveBeenCalledTimes(1)
    expect(r.result).toMatchObject({ engine: 'omni', fallback: true })
  })
  it('every slot (normal, plainer, fallback; two attempts) is distinct and above the still slots', () => {
    const all = [1, 2, 9].flatMap((n) => [0, 1].flatMap((a) => (['normal', 'plain', 'fallback'] as const).map((v) => clipSlot(n, a, v))))
    expect(new Set(all).size).toBe(all.length)
    expect(Math.min(...all)).toBeGreaterThanOrEqual(1000)
  })
})

describe('M5/M6 plain, true wording', () => {
  it('a clip that was never made is not described as failing its checks', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const note = differenceNote({ plan, stills: [], musicMade: true, checks: [], clips: [
      { look: 1, fileId: null, localPath: null, engine: 'omni', fallback: false, status: 'failed', reasons: ['not enough credits'], failedChecks: false },
      { look: 2, fileId: 'c', localPath: '/c', engine: 'veo', fallback: false, status: 'failed', reasons: ['end pose: knees'], failedChecks: true },
    ] })
    expect(note).toMatch(/Part 1 couldn’t be animated: not enough credits/)
    expect(note).toMatch(/Part 2 didn’t pass its checks after a second try/)
  })
  it('clip check reasons talk about the clip, not a still', async () => {
    const look = remakeLooks(breakdown())[0]
    const pose = { model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 5, frames_used: 9, people: 0, people_max: 0, no_person: true, main_start: null, main_end: null, leg_side_start: 'unknown' as const, leg_side_end: 'unknown' as const, body_angle_end: null, key_frames: [] }] }
    const r = await checkClip({ clipPath: '/c', seconds: 5, look, portrait: null, tenantId: 't' }, { poseClip: vi.fn(async () => pose), sample: vi.fn(async () => []), gate: vi.fn(async (_s: unknown, name: string) => ({ ...pass, name })) } as never)
    expect(r.reason).toMatch(/in the clip/)
    expect(r.reason).not.toMatch(/still/)
  })
})

// Workflow-level: square reels (M4), approvals (M7), temp dirs (M9), music key (M8), status text (M10).
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
const sameBody = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const resume = async (id: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId: id })).resume({ step, resumeData: data, requestContext: rc() })
async function toPreview(b = sameBody(), o: Partial<RemakeDeps> = {}) {
  setRemakeDeps(wfDeps(o))
  const run = await (await wf()).w.createRun()
  await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
  await resume(run.runId, 'plan', { decision: 'approve' })
  const r = await resume(run.runId, 'cast', { pick: 1 })
  return { id: run.runId, r }
}
const exec = (input: Record<string, unknown>) => remakeVideoTool.execute!(input as never, { requestContext: rc() } as never) as Promise<Record<string, unknown>>
const need = (input: Record<string, unknown>) => (remakeVideoTool.requireApproval as (i: unknown, c: unknown) => Promise<boolean>)(input, { requestContext: rc() })

describe('workflow minors', () => {
  beforeEach(() => setRemakeStorageForTests(new InMemoryStore()))
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

  it('M4 a square reel: no clips estimate, approve_preview asks for no approval and refuses plainly, no spend', async () => {
    const b = sameBody(); b.video = { ...b.video, width: 1080, height: 1080 }
    const omni = vi.fn(); const veo = vi.fn()
    const { id } = await toPreview(b, { generateOmniClip: omni, generateVeoClip: veo } as never)
    const status = await exec({ action: 'status', runId: id })
    expect(status).toMatchObject({ stage: 'preview_review', cantAnimate: expect.stringMatching(/square/i) })
    expect(status.clipsEstimate).toBeUndefined()
    expect(await need({ action: 'approve_preview', runId: id })).toBe(false)
    const r = await exec({ action: 'approve_preview', runId: id })
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/square/i) })
    expect(omni).not.toHaveBeenCalled(); expect(veo).not.toHaveBeenCalled()
  })

  it('M7 approve_preview asks for approval when either clip model is priced (Omni alone here)', async () => {
    const { id } = await toPreview()
    expect(await need({ action: 'approve_preview', runId: id })).toBe(true)
  })

  it('M9 every temp dir a run makes is removed by the end', async () => {
    const made: string[] = []; const removed: string[] = []
    let i = 0
    const o = { tempDir: vi.fn((prefix: string) => { const d = `/tmp/fake-${prefix}${++i}`; made.push(d); return d }), removeDir: vi.fn((d: string) => { removed.push(d) }) }
    const { id } = await toPreview(sameBody(), o as never)
    await resume(id, 'preview', { decision: 'approve' })
    expect(made.length).toBeGreaterThan(3)
    expect(new Set(removed)).toEqual(new Set(made))
  })

  it('M8 the music is charged under a key fixed to the run (never twice for one run)', async () => {
    const music = vi.fn(async () => ({ fileId: 'music-1', creditsUsedMicro: '8' }))
    const { id } = await toPreview(sameBody(), { generateMusic: music } as never)
    await resume(id, 'preview', { decision: 'approve' })
    expect(music).toHaveBeenCalledWith(expect.any(String), expect.anything(), `remake:${id}:music`)
  })

  it('M10 the tool says "working" covers stills and clips', () => {
    expect(remakeVideoTool.description).toMatch(/working means it is still making the stills or the clips/)
  })
})

describe('M11 a gap between looks never freezes a frame (clips are retimed, not padded)', () => {
  it('the look frames include the gap and the clip is fitted to all of them', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    plan.looks[1] = { ...plan.looks[1], startS: 4.5 } // 0.4s gap after look 1
    const [, b] = clipSpecs(plan, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(b.frames).toBe(177) // 300 − 123: the gap belongs to look 2, and fitToFrames retimes to it
  })
})
