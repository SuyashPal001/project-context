import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); return r }
const pass = { name: 'x', status: 'pass', reason: '', evidenceTimes: [] }
let n = 0
const sameBody = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }
function deps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  const body = breakdown().pose!.looks[0].main_start
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '10' })),
    fetchImage: vi.fn(async () => ({ data: 'AA', mime: 'image/jpeg' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn(async () => ({ model: 'm', people: 1, no_person: false, main: body })),
    cutBoard: vi.fn(async (_f: string, n: number) => Array.from({ length: n }, (_, k) => `panel-${k + 1}`)),
    promptGate: vi.fn(async () => pass),
    stillChecks: vi.fn(async () => ({ passed: true, reasons: [] })),
    ffmpeg: vi.fn(async () => undefined), readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn(async () => '/m/preview.mp4'),
    imageRateMicro: vi.fn(async () => 10n),
    clipRateMicro: vi.fn(async (e: 'veo' | 'omni') => (e === 'veo' ? 160n : 100n)),
    musicRateMicro: vi.fn(async () => 8n),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '160' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    fitToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    poseClip: vi.fn(async () => ({ model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people: 1, people_max: 1, no_person: false, main_start: body, main_end: body, leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [] }] })),
    sample: vi.fn(async () => [{ data: 'AA', mime: 'image/jpeg' }]),
    generateMusic: vi.fn(async () => ({ fileId: 'music-1', creditsUsedMicro: '8' })),
    compare: vi.fn(async () => ({ checks: [pass], brightnessJumps: null, summary: 'ok' })),
    stillToFrames: vi.fn(async (_s: string | null, _f: number, out: string) => out),
    joinSegments: vi.fn(async (_p: string[], out: string) => out),
    fitMusic: vi.fn(async (_m: string, _s: number, out: string) => out),
    muxMusic: vi.fn(async (_v: string, _m: string, out: string) => out),
    ...o,
  } as Partial<RemakeDeps>
}
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const resume = async (id: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId: id })).resume({ step, resumeData: data, requestContext: rc() })
async function toPreview(b = sameBody(), o: Partial<RemakeDeps> = {}) {
  setRemakeDeps(deps(o))
  const run = await (await wf()).w.createRun()
  await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
  await resume(run.runId, 'plan', { decision: 'approve' })
  const r = await resume(run.runId, 'cast', { pick: 1 })
  return { id: run.runId, r }
}
const payload = (r: unknown, step: string) => (r as { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps[step].suspendPayload!

beforeEach(() => { n = 0; setRemakeStorageForTests(new InMemoryStore()) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('3b workflow', () => {
  it('pauses at the preview with a clips + music estimate, before any clip is paid', async () => {
    const veo = vi.fn()
    const { r } = await toPreview(sameBody(), { generateVeoClip: veo } as never)
    expect(r.status).toBe('suspended')
    const p = payload(r, 'preview')
    expect(p.stage).toBe('preview_review')
    expect(p.clipsEstimate).toMatchObject({ clips: 2, firstPassMicro: '268' }) // omni 100 + veo 160 + music 8
    expect(veo).not.toHaveBeenCalled()
  })
  it('approve makes the clips, joins them with music, checks, and delivers with a note', async () => {
    const { id } = await toPreview()
    const done = await resume(id, 'preview', { decision: 'approve' })
    expect(done.status).toBe('success')
    const out = (done as unknown as { result: Record<string, unknown> }).result
    expect(out.finalFileId).toMatch(/^up:/)
    expect(String(out.note)).toMatch(/AI-generated/)
    expect((out.summary as { spentMicro: string }).spentMicro).toBe(String(10 + 10 + 30 + 100 + 160 + 8)) // casting sheet + reference sheet + 3 stills (edit chain, no boards) + clips + music
  })
  it('stop ends with the preview only, no clip spend', async () => {
    const omni = vi.fn()
    const { id } = await toPreview(sameBody(), { generateOmniClip: omni } as never)
    const done = await resume(id, 'preview', { decision: 'stop' })
    expect(done.status).toBe('success')
    expect(omni).not.toHaveBeenCalled()
  })
  it('a square reel can be previewed but not animated: approve spends nothing (Review Focus 2)', async () => {
    const b = sameBody(); b.video = { ...b.video, width: 1080, height: 1080 }
    const omni = vi.fn(); const veo = vi.fn()
    const { id, r } = await toPreview(b, { generateOmniClip: omni, generateVeoClip: veo } as never)
    expect(String(payload(r, 'preview').cantAnimate)).toMatch(/square/i)
    const done = await resume(id, 'preview', { decision: 'approve' })
    expect(done.status).toBe('success')
    expect(omni).not.toHaveBeenCalled(); expect(veo).not.toHaveBeenCalled()
  })
  it('music failing still delivers the video, silent, and says so', async () => {
    const { id } = await toPreview(sameBody(), { generateMusic: vi.fn(async () => ({ refused: true })) } as never)
    const out = ((await resume(id, 'preview', { decision: 'approve' })) as unknown as { result: { note: string; finalFileId: string } }).result
    expect(out.finalFileId).toBeTruthy()
    expect(out.note).toMatch(/music couldn’t be made/)
  })
  it('the comparison throwing still delivers, with a plain note (Review Focus 5)', async () => {
    const { id } = await toPreview(sameBody(), { compare: vi.fn(async () => { throw new Error('ai-service 500') }) } as never)
    const out = ((await resume(id, 'preview', { decision: 'approve' })) as unknown as { result: { note: string } }).result
    expect(out.note).toMatch(/couldn’t be run this time/)
    expect(out.note).not.toMatch(/ai-service/)
  })
})
