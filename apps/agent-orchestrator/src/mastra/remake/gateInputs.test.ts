// Live run 08466630 (2026-10-16): both stills were blocked by our own prompt check — false
// alarms built into what we handed it. And an all-grey video was then delivered as finished.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'
import { writePlan, applyEdits } from './plan.js'
import { stillGateInput } from './prompts.js'
import { clipGateInput } from './clipSpec.js'
import { promptCheckScorer } from '../scorers/video/promptCheck.js'
import { shapeRun } from './remakeVideoTool.js'

const brand = { name: 'Snitch', product: 'tee', audience: 'young men' }
const castTo = 'A charismatic man in his early 20s with a trendy streetwear look'
const plan = async () => applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'cast', action: 'swap', to: castTo }], brand)

describe('the prompt check gets only what the generation is actually given', () => {
  it('a START still is checked against the START body only (not the look-level measured line)', async () => {
    const p = await plan()
    const g = stillGateInput(p, p.looks[1], 'start', 'P') // look b: start knees bent, end knees straight
    const s = JSON.stringify(g.look)
    expect(s).toMatch(/knees bent/)
    expect(s).not.toMatch(/knees straight/)
    expect(g.look).not.toHaveProperty('measured')
    expect(g.look).not.toHaveProperty('end_pose')
  })
  it('an END still is checked against the END body only', async () => {
    const p = await plan()
    const s = JSON.stringify(stillGateInput(p, p.looks[1], 'end', 'P').look)
    expect(s).toMatch(/knees straight/)
    expect(s).not.toMatch(/knees bent/)
  })
  it('the person comes from the reference image: the cast description is not a line the prompt must contain', async () => {
    const p = await plan()
    const still = stillGateInput(p, p.looks[0], 'start', 'P').planLine
    const clip = clipGateInput(p, p.looks[0], 'P').planLine
    for (const line of [still, clip]) {
      expect(line).not.toContain(castTo)
      expect(line).toMatch(/given by the first reference image/)
    }
  })
  it('a clip is checked against its start and end bodies, never the look-level line', async () => {
    const p = await plan()
    const g = clipGateInput(p, p.looks[1], 'P').look
    expect(g).not.toHaveProperty('measured')
    expect(JSON.stringify(g)).toMatch(/body_at_start.*knees bent/)
    expect(JSON.stringify(g)).toMatch(/body_at_end.*knees straight/)
  })
  it('the checker is told identity comes from images and measured body words are authoritative', async () => {
    const ask = vi.fn().mockResolvedValue({ invented: [], contradicts: [], missing: [], hand_on_absent_object: [] })
    await promptCheckScorer.run({ input: { ask, prompt: 'x', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, output: null })
    const q = (ask.mock.calls[0][0] as Array<{ text: string }>)[0].text
    expect(q).toMatch(/identity.*reference image/i)
    expect(q).toMatch(/measured/i)
  })
})

// Workflow: nothing real to show must never become a "finished" video.
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); return r }
function deps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  let n = 0
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '10' })),
    fetchImage: vi.fn(async () => ({ data: 'AA', mime: 'image/jpeg' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn(async () => ({ model: 'm', people: 1, no_person: false, main: breakdown().pose!.looks[0].main_start })),
    // every still prompt is blocked, the casting sheet passes
    promptGate: vi.fn(async (i: { planLine: string }) => (i.planLine.startsWith('casting sheet') ? pass : { ...pass, status: 'fail', reason: 'contradicts: knees straight' })),
    stillChecks: vi.fn(async () => ({ passed: true, reasons: [] })),
    ffmpeg: vi.fn(async () => undefined), readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn(async () => '/m/preview.mp4'), imageRateMicro: vi.fn(async () => 10n),
    clipRateMicro: vi.fn(async () => 100n), musicRateMicro: vi.fn(async () => 8n),
    generateMusic: vi.fn(async () => ({ fileId: 'music', creditsUsedMicro: '8' })),
    compare: vi.fn(async () => ({ checks: [pass], summary: 'ok' })),
    stillToFrames: vi.fn(async (_s: string | null, _f: number, out: string) => out),
    joinSegments: vi.fn(async (_p: string[], out: string) => out),
    fitMusic: vi.fn(async (_m: string, _s: number, out: string) => out),
    muxMusic: vi.fn(async (_v: string, _m: string, out: string) => out),
    tempDir: vi.fn((p: string) => `/tmp/x-${p}`), removeDir: vi.fn(), deleteFile: vi.fn(async () => true),
    ...o,
  } as Partial<RemakeDeps>
}
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const resume = async (id: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId: id })).resume({ step, resumeData: data, requestContext: rc() })

describe('nothing real to show is never delivered as finished', () => {
  beforeEach(() => setRemakeStorageForTests(new InMemoryStore()))
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  it('no still made: the preview says there is nothing to animate (no clips price)', async () => {
    setRemakeDeps(deps())
    const run = await (await wf()).w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: breakdown(), brand }, requestContext: rc() })
    await resume(run.runId, 'plan', { decision: 'approve' })
    const r = await resume(run.runId, 'cast', { pick: 1 })
    const p = (r as unknown as { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps.preview.suspendPayload!
    expect(String(p.cantAnimate)).toMatch(/none of the stills could be made/i)
    expect(p.clipsEstimate).toBeUndefined()
  })
  it('a finish with no real picture in any part uploads nothing, pays for no music, and comes back as final_failed', async () => {
    const music = vi.fn(); const upload = vi.fn(async (_t: string, key: string, _name?: string) => `up:${key.split('/').pop()}`); const compare = vi.fn()
    setRemakeDeps(deps({ generateMusic: music, upload, compare } as never))
    const run = await (await wf()).w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: breakdown(), brand }, requestContext: rc() })
    await resume(run.runId, 'plan', { decision: 'approve' })
    await resume(run.runId, 'cast', { pick: 1 })
    // force past the preview even though it can't be animated (approve is treated as stop there);
    // the finish guard is checked directly through a stop=false run below
    const done = await resume(run.runId, 'preview', { decision: 'approve' })
    const out = (done as unknown as { result: Record<string, unknown> }).result
    expect(music).not.toHaveBeenCalled(); expect(compare).not.toHaveBeenCalled()
    expect(upload.mock.calls.some((c) => String(c[2]).startsWith('Remake.mp4'))).toBe(false)
    expect(out.finalFileId).toBeNull()
  })
  it('shapes a no-picture result as final_failed with the parts’ reasons', () => {
    const summary = { spentMicro: '0', wastedMicro: '0', failed: [], blocked: ['look 1 start still'] }
    expect(shapeRun('r', { status: 'success', result: { finalFileId: null, stopped: false, nothingToShow: true, note: 'Part 1 stays a still: x', clips: [], summary } }))
      .toMatchObject({ success: false, stage: 'final_failed', error: expect.stringMatching(/no part of the video could be made/i) })
  })
})
