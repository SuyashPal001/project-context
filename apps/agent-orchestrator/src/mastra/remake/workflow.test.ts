import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda', audience: 'students' }
const rc = (tenantId = 't1') => { const r = new RequestContext(); r.set('tenantId', tenantId); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
let made = 0
let store: InMemoryStore
type Steps = { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }

function fakeDeps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow Bubbli tee' }] }),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' })),
    fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }),
    localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
    upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: breakdown().pose!.looks[0].main_start }),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn().mockResolvedValue('/m/preview.mp4'),
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    ...o,
  }
}

beforeEach(() => { made = 0; store = new InMemoryStore(); setRemakeStorageForTests(store) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

// Both looks start with the same measured body as the fake still reading, so stills pass first time.
const ref = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }

async function start(o: Partial<RemakeDeps> = {}, input: Record<string, unknown> = {}) {
  setRemakeDeps(fakeDeps(o))
  const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)
  const run = await w.createRun()
  const r = await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: ref(), brand, ...input }, requestContext: rc() })
  return { w, runId: run.runId, r }
}
const resume = async (runId: string, step: string, resumeData: unknown, ctx = rc()) =>
  (await ((await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)).createRun({ runId })).resume({ step, resumeData, requestContext: ctx })

describe('video-remake workflow', () => {
  it('stops for the plan review with the plan and a cost estimate, before any spend', async () => {
    const gen = vi.fn()
    const { r } = await start({ generateStill: gen })
    expect(r.status).toBe('suspended')
    const s = (r as unknown as Steps).steps.plan.suspendPayload!
    expect(s.stage).toBe('plan_review')
    expect((s.plan as { lines: Array<{ ref: string; to?: string }> }).lines.find((l) => l.ref === 'looks[0].outfit')?.to).toBe('yellow Bubbli tee')
    expect(s.estimate).toMatchObject({ images: 4, firstPassMicro: '4000000' })
    expect(gen).not.toHaveBeenCalled()
  })
  it('an edit re-suspends with the edited plan; approve moves to the casting sheet', async () => {
    const { runId } = await start()
    const e = await resume(runId, 'plan', { decision: 'edit', edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    expect(e.status).toBe('suspended')
    const a = await resume(runId, 'plan', { decision: 'approve' })
    expect(a.status).toBe('suspended')
    const cast = (a as unknown as Steps).steps.cast.suspendPayload!
    expect(cast).toMatchObject({ stage: 'cast_pick', sheetFileId: 'img-1' })
  })
  it('the pick crops that panel, makes every still with the edit applied, and renders the free preview', async () => {
    const gen = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const { runId } = await start({ generateStill: gen })
    await resume(runId, 'plan', { decision: 'edit', edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    await resume(runId, 'plan', { decision: 'approve' })
    const done = await resume(runId, 'cast', { pick: 2 })
    expect(done.status).toBe('success')
    const out = (done as unknown as { result: Record<string, unknown> }).result
    expect(out.previewFileId).toBeTruthy()
    expect((out.stills as unknown[]).length).toBe(3)
    const prompts = gen.mock.calls.map((c) => c[0].prompt as string)
    expect(prompts.some((p) => p.includes('green kurta'))).toBe(true)
    expect(gen.mock.calls[1][0].referenceFileIds[0]).toMatch(/^up:/) // the cropped portrait comes first
    expect(out.summary).toMatchObject({ spentMicro: '400', wastedMicro: '0' }) // sheet + 3 stills
  })
  it('skips casting for a reel with nobody in it', async () => {
    const b = breakdown(); b.pose!.looks = b.pose!.looks.map((l) => ({ ...l, people: 0, no_person: true, main_start: null, main_end: null }))
    setRemakeDeps(fakeDeps({ poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 0, no_person: true, main: null }) }))
    const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID); const run = await w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
    const done = await resume(run.runId, 'plan', { decision: 'approve' })
    expect(done.status).toBe('success')
  })
  it('a resume from another tenant fails without spending', async () => {
    const gen = vi.fn()
    const { runId } = await start({ generateStill: gen })
    const r = await resume(runId, 'plan', { decision: 'approve' }, rc('intruder'))
    expect(r.status).toBe('failed')
    expect(gen).not.toHaveBeenCalled()
  })
  it('survives a fresh instance on the same store (an orchestrator restart)', async () => {
    const { runId } = await start()
    setRemakeStorageForTests(store) // rebuilds the private instance on the same storage
    const r = await resume(runId, 'plan', { decision: 'approve' })
    expect(r.status).toBe('suspended')
  })
})
