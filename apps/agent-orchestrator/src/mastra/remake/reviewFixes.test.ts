// Final-review fixes (Opus review of video-phase3a): each test reproduces one finding.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { makeStill, type StillCtx } from './paidStill.js'
import { remakeLooks } from './looks.js'
import { breakdown } from './fixtures.testing.js'
import { GENERATION_APPROVAL_METADATA } from '../tools/generationApproval.js'
import { shapeRun } from './remakeVideoTool.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); return r }
type Steps = { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }
let made = 0
const pass = { name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }
const sameBody = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }
function deps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' })),
    fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }),
    localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
    upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: breakdown().pose!.looks[0].main_start }),
    cutBoard: vi.fn(async (_f: string, n: number) => Array.from({ length: n }, (_, k) => `panel-${k + 1}`)),
    promptGate: vi.fn().mockResolvedValue(pass),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn().mockResolvedValue('/m/preview.mp4'),
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    clipRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    ...o,
  }
}
// Wrapped: a Workflow is a thenable, so an async function must never return one bare.
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
async function startRun(b = sameBody(), o: Partial<RemakeDeps> = {}) {
  setRemakeDeps(deps(o))
  const run = await (await wf()).w.createRun()
  await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
  return run.runId
}
const resume = async (runId: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId })).resume({ step, resumeData: data, requestContext: rc() })
const castPayload = (r: unknown) => (r as Steps).steps.cast.suspendPayload!

beforeEach(() => { made = 0; setRemakeStorageForTests(new InMemoryStore()) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('C1 approval card', () => {
  it('remake_video has an approval card priced as image generation, naming the stage', () => {
    const meta = GENERATION_APPROVAL_METADATA['remake_video']
    expect(meta?.resourceType).toBe('image_generation')
    expect(meta.buildPreview!({ action: 'approve_plan' })).toMatch(/casting sheet/)
    // 2026-10-16: the pick makes the person's sheet for approval; the stills come with approve_person
    expect(meta.buildPreview!({ action: 'pick_cast' })).toMatch(/reference sheet for you to approve/)
    expect(meta.buildPreview!({ action: 'change_person' })).toMatch(/same person/)
    expect(meta.buildPreview!({ action: 'approve_person' })).toMatch(/every still/)
    expect(meta.buildPreview!({ action: 'approve_preview' })).toMatch(/Animates every part/)
    expect(meta.subjectFor!({ action: 'approve_preview' }, undefined)).toBe('google/veo-3.1-fast-generate-001')
    expect(meta.resourceTypeFor!({ action: 'approve_preview' })).toBe('video_generation')
    expect(meta.resourceTypeFor!({ action: 'pick_cast' })).toBe('image_generation')
  })
})

describe('I1 one still failing does not kill the run', () => {
  it('a guide frame that cannot be made fails only that still; the rest and the preview go on', async () => {
    // One frame can never be made (a frame failing once is now retried by the still itself).
    const runId = await startRun(sameBody(), { ffmpeg: vi.fn().mockImplementation(async (args: string[]) => { if (args[0] === '-ss' && /guide-1-start/.test(args[args.length - 1])) throw new Error('ENOENT') }) })
    await resume(runId, 'plan', { decision: 'approve' })
    const done = await resume(runId, 'cast', { pick: 1 })
    expect(done.status).toBe('suspended') // 3b: paused at the preview review
    const out = (done as unknown as Steps).steps.preview.suspendPayload! as unknown as { stills: Array<{ status: string; reasons: string[] }>; previewFileId: string }
    expect(out.stills.filter((s) => s.status === 'failed')).toHaveLength(1)
    expect(out.stills.find((s) => s.status === 'failed')!.reasons.join(' ')).not.toMatch(/ENOENT/)
    expect(out.previewFileId).toBeTruthy()
  })
})

describe('I2 the cast step can be retried without paying for a new sheet', () => {
  it('a failed save after the pick asks to pick again with the same sheet', async () => {
    const upload = vi.fn().mockResolvedValueOnce(null).mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`)
    const gen = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const runId = await startRun(sameBody(), { upload, generateStill: gen })
    await resume(runId, 'plan', { decision: 'approve' })
    const again = await resume(runId, 'cast', { pick: 2 })
    expect(again.status).toBe('suspended')
    expect(castPayload(again)).toMatchObject({ stage: 'cast_pick', sheetFileId: 'img-1' })
    expect(String(castPayload(again).error)).toMatch(/pick again/)
    expect(gen).toHaveBeenCalledTimes(1)
    expect((await resume(runId, 'cast', { pick: 2 })).status).toBe('suspended') // 3b: on to the preview review
  })
  it('a sheet that could not be made waits for a retry instead of ending the run', async () => {
    const gen = vi.fn().mockResolvedValueOnce({ insufficientCredits: true }).mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const runId = await startRun(sameBody(), { generateStill: gen })
    const r = await resume(runId, 'plan', { decision: 'approve' })
    expect(r.status).toBe('suspended')
    expect(castPayload(r)).toMatchObject({ stage: 'cast_pick', sheetFileId: null })
    expect(String(castPayload(r).error)).toMatch(/not enough credits/)
    const retry = await resume(runId, 'cast', {})
    expect(castPayload(retry)).toMatchObject({ stage: 'cast_pick', sheetFileId: 'img-1' })
  })
  it('asking again with no pick while a sheet exists never pays for a new sheet', async () => {
    const gen = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const runId = await startRun(sameBody(), { generateStill: gen })
    await resume(runId, 'plan', { decision: 'approve' })
    const r = await resume(runId, 'cast', {})
    expect(castPayload(r)).toMatchObject({ sheetFileId: 'img-1' })
    expect(gen).toHaveBeenCalledTimes(1)
  })
})

describe('I3 status of a run in progress', () => {
  it('a running run reads as working, never as stopped', () => {
    expect(shapeRun('r1', { status: 'running' })).toMatchObject({ success: true, stage: 'working' })
  })
  it('acting on a step that is already past reads plainly', () => {
    expect(shapeRun('r1', { status: 'failed', error: new Error('This workflow step "plan" was not suspended') })).toMatchObject({ success: false, error: expect.stringMatching(/already/) })
  })
})

describe('I4 a look whose people were not measured is not paid for', () => {
  it('blocks that look before any spend and still makes the others', async () => {
    const b = sameBody(); b.pose!.looks[1] = { ...b.pose!.looks[1], people: null, no_person: null }
    const gen = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const runId = await startRun(b, { generateStill: gen })
    await resume(runId, 'plan', { decision: 'approve' })
    const done = await resume(runId, 'cast', { pick: 1 })
    const out = (done as unknown as Steps).steps.preview.suspendPayload! as unknown as { stills: Array<{ look: number; status: string }> }
    expect(out.stills.filter((s) => s.look === 2).every((s) => s.status === 'blocked')).toBe(true)
    expect(gen.mock.calls.every((c) => !String(c[0].prompt).includes('Pose: sits'))).toBe(true)
  })
  it('a look where a person shows only part of the time is blocked too', () => {
    const b = breakdown(); b.pose!.looks[0] = { ...b.pose!.looks[0], people: 0, people_max: 1, no_person: true }
    expect(remakeLooks(b)[0].measuredPeople).toBe(false)
  })
})

describe('I5/I7 paid still', () => {
  const look = remakeLooks(breakdown())[0]
  const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null }
  const job = { look, kind: 'start' as const, prompt: 'P', references: ['p', 'g'], aspectRatio: '9:16' as const, gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
  it('never lets an avatar sheet push the pose guide out of place', async () => {
    const d = deps() as RemakeDeps
    await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledWith(expect.objectContaining({ skipAvatarExpansion: true }), expect.anything(), expect.any(Number))
  })
  it('a gate that could not run says so in plain words, never the raw error', async () => {
    const d = deps({ promptGate: vi.fn().mockResolvedValue({ ...pass, status: 'unknown', reason: 'check unavailable: gateway 503' }) }) as RemakeDeps
    const r = await makeStill(job, ctx, d)
    expect(r.result.reasons.join(' ')).not.toMatch(/gateway|503|check unavailable/)
    expect(r.result.reasons.join(' ')).toMatch(/couldn’t be checked/)
  })
})

describe('I6 the casting sheet is gated before it is paid for', () => {
  it('a blocked cast prompt pays nothing and waits for a plan change', async () => {
    const gen = vi.fn()
    const gate = vi.fn().mockImplementation(async (i: { planLine: string }) => (i.planLine.startsWith('casting sheet') ? { ...pass, status: 'fail', reason: 'invented: the name of a real person' } : pass))
    const runId = await startRun(sameBody(), { generateStill: gen, promptGate: gate })
    const r = await resume(runId, 'plan', { decision: 'approve' })
    expect(gen).not.toHaveBeenCalled()
    expect(castPayload(r)).toMatchObject({ stage: 'cast_pick', sheetFileId: null })
    expect(String(castPayload(r).error)).toMatch(/real person/)
  })
})
