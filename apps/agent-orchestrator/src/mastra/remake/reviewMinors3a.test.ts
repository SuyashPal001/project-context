// The deferred minors from the 3a review (M1–M9), each pinned by a test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown, body } from './fixtures.testing.js'
import { writePlan, applyEdits } from './plan.js'
import { previewSegments } from './preview.js'
import { comparePose } from './poseCompare.js'
import { makeStill, type StillCtx } from './paidStill.js'
import { remakeLooks } from './looks.js'

vi.mock('../tools/videoBreakdown/breakDownVideo.js', async (orig) => ({ ...(await orig<typeof import('../tools/videoBreakdown/breakDownVideo.js')>()), recentBreakdown: vi.fn(() => sameBody()), breakDownVideo: vi.fn(async () => sameBody()) }))
vi.mock('../tools/generationApproval.js', async (orig) => ({ ...(await orig<typeof import('../tools/generationApproval.js')>()), shouldRequireApproval: vi.fn(async () => true) }))
const { remakeVideoTool } = await import('./remakeVideoTool.js')

const brand = { name: 'B', product: 'p' }
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
function sameBody() { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }

function deps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  const main = breakdown().pose!.looks[0].main_start
  let n = 0
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '10' })),
    fetchImage: vi.fn(async () => ({ data: 'AA', mime: 'image/jpeg' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn(async () => ({ model: 'm', people: 1, no_person: false, main })),
    cutBoard: vi.fn(async (_f: string, n: number) => Array.from({ length: n }, (_, k) => `panel-${k + 1}`)),
    promptGate: vi.fn(async () => pass), stillChecks: vi.fn(async () => ({ passed: true, reasons: [] })),
    ffmpeg: vi.fn(async () => undefined), readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn(async () => '/m/preview.mp4'), imageRateMicro: vi.fn(async () => 10n),
    clipRateMicro: vi.fn(async () => 100n), musicRateMicro: vi.fn(async () => 8n),
    tempDir: vi.fn((p: string) => `/tmp/fake-${p}`), removeDir: vi.fn(), deleteFile: vi.fn(async () => true),
    ...o,
  } as Partial<RemakeDeps>
}
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const rc = (o: Record<string, string> = {}) => { const r = new RequestContext(); for (const [k, v] of Object.entries({ tenantId: 't1', idToken: 'JWT-SECRET-123', conversationId: 'c1', sessionId: 's1', userId: 'user-9', agentSystemPrompt: 'SYSTEM PROMPT TEXT', ...o })) r.set(k, v); return r }
const tool = (input: Record<string, unknown>) => remakeVideoTool.execute!(input as never, { requestContext: rc() } as never) as Promise<Record<string, unknown>>

let store: InMemoryStore
beforeEach(() => { store = new InMemoryStore(); setRemakeStorageForTests(store) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('M1 the login token and chat context are never stored with a paused run', () => {
  it('a run started and resumed through the tool stores no idToken, userId or system prompt', async () => {
    setRemakeDeps(deps())
    const { runId } = await tool({ action: 'start', url: 'instagram.com/p/x', brand })
    await tool({ action: 'approve_plan', runId })
    // The raw stored snapshot (getWorkflowRunById hides its requestContext field).
    const wfStore = await (store as unknown as { getStore: (d: string) => Promise<{ loadWorkflowSnapshot: (a: { workflowName: string; runId: string }) => Promise<unknown> }> }).getStore('workflows')
    const state = JSON.stringify(await wfStore.loadWorkflowSnapshot({ workflowName: REMAKE_WORKFLOW_ID, runId: runId as string }))
    expect(state).toContain('t1') // the snapshot was read
    expect(state).not.toContain('JWT-SECRET-123')
    expect(state).not.toContain('user-9')
    expect(state).not.toContain('SYSTEM PROMPT TEXT')
  })
  it('the steps still get the token they need for paid calls (the casting sheet is made)', async () => {
    const gen = vi.fn(async (_i: unknown, exec: { requestContext?: { get: (k: string) => unknown } }) => ({ fileId: exec.requestContext?.get('idToken') === 'JWT-SECRET-123' ? 'sheet-ok' : undefined, creditsUsedMicro: '10' }))
    setRemakeDeps(deps({ generateStill: gen } as never))
    const { runId } = await tool({ action: 'start', url: 'instagram.com/p/x', brand })
    expect(await tool({ action: 'approve_plan', runId })).toMatchObject({ stage: 'cast_pick', sheetFileId: 'sheet-ok' })
  })
})

describe('M2 a still that failed its checks is never shown as fine in the preview', () => {
  it('becomes a grey card in the preview (it is still listed with its reasons)', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const segs = previewSegments(plan, [
      { look: 1, kind: 'start', fileId: 'a1', status: 'failed', reasons: ['two cans'] },
      { look: 2, kind: 'start', fileId: 'b1', status: 'unchecked', reasons: [] },
    ], new Map([['a1', '/m/a1.jpg'], ['b1', '/m/b1.jpg']]))
    expect(segs[0].start).toBeNull()
    expect(segs[1].start).toBe('/m/b1.jpg')
  })
})

describe('M3/M4 stills step', () => {
  it('M3 once credits run out, the remaining stills stop: no more guides, gates or calls', async () => {
    const gen = vi.fn(async () => ({ insufficientCredits: true }))
    const gate = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return pass })
    // The casting sheet's, the reference sheet's and the first still's checks are quick; the other stills' are slower,
    // so the first still runs out of credits while they are still being checked.
    let calls = 0
    const gateFirstFast = vi.fn(async (...a: unknown[]) => (++calls <= 3 ? pass : gate(...(a as []))))
    setRemakeDeps(deps({ generateStill: vi.fn(async (i: { title?: string }) => (String(i.title).includes('sheet') ? { fileId: 'sheet', creditsUsedMicro: '10' } : gen())), promptGate: gateFirstFast } as never))
    const run = await (await wf()).w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: sameBody(), brand }, requestContext: rc() })
    await (await wf()).w.createRun({ runId: run.runId }).then((r) => r.resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() }))
    const done = await (await wf()).w.createRun({ runId: run.runId }).then((r) => r.resume({ step: 'cast', resumeData: { pick: 1 }, requestContext: rc() }))
    const stills = (done as unknown as { steps: Record<string, { suspendPayload?: { stills: Array<{ reasons: string[] }> } }> }).steps.preview.suspendPayload!.stills
    expect(gen).toHaveBeenCalledTimes(1)
    expect(stills.every((s) => s.reasons.join(' ').includes('not enough credits'))).toBe(true)
  })
  it('M4 the pose-guide frames (the original person) are deleted from the user’s files after the stills', async () => {
    const del = vi.fn(async () => true)
    const upload = vi.fn(async (_t: string, _k: string, name: string) => `id:${name}`)
    setRemakeDeps(deps({ deleteFile: del, upload } as never))
    const run = await (await wf()).w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: sameBody(), brand }, requestContext: rc() })
    await (await wf()).w.createRun({ runId: run.runId }).then((r) => r.resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() }))
    await (await wf()).w.createRun({ runId: run.runId }).then((r) => r.resume({ step: 'cast', resumeData: { pick: 1 }, requestContext: rc() }))
    const deleted = del.mock.calls.map((c) => String((c as unknown[])[1]))
    expect(deleted.sort()).toEqual(['id:Remake look 1 start guide.jpg', 'id:Remake look 2 end guide.jpg', 'id:Remake look 2 start guide.jpg']) // no boards for people since 2026-10-16
    expect(del.mock.calls.every((c) => (c as unknown[])[0] === 'JWT-SECRET-123')).toBe(true)
  })
})

describe('M5 people counts are compared for group shots too', () => {
  it('a 3-person reference fails a 1-person still', () => {
    expect(comparePose(body(), 3, { model: 'm', people: 1, no_person: false, main: body() }).status).toBe('fail')
    expect(comparePose(body(), 3, { model: 'm', people: 3, no_person: false, main: body() }).status).toBe('pass')
  })
})

describe('M6/M9 paid still ledger and reasons', () => {
  const look = remakeLooks(breakdown())[0]
  const job = { look, kind: 'start' as const, prompt: 'P', references: ['p', 'g'], aspectRatio: '9:16' as const, gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
  const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null }
  const base = (o: Partial<RemakeDeps>) => ({ ...deps(), poseImage: vi.fn(async () => ({ model: 'm', people: 2, no_person: false, main: look.start })), ...o }) as RemakeDeps
  it('M6 a retry blocked after a failed attempt reads failed in both the result and the ledger', async () => {
    const d = base({ promptGate: vi.fn().mockResolvedValueOnce(pass).mockResolvedValueOnce({ ...pass, status: 'fail', reason: 'adds a smile' }) } as never)
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('failed')
    expect(r.ledger.map((e) => e.outcome)).toEqual(['failed'])
  })
  it('M9 running out of credits on the retry keeps the first try’s reason', async () => {
    const d = base({ generateStill: vi.fn().mockResolvedValueOnce({ fileId: 's1', creditsUsedMicro: '10' }).mockResolvedValueOnce({ insufficientCredits: true }) } as never)
    const r = await makeStill(job, ctx, d)
    expect(r.result.reasons.join(' ')).toMatch(/extra person/)
    expect(r.result.reasons.join(' ')).toMatch(/not enough credits/)
  })
})

describe('M7 edits keep the plan’s earlier warnings', () => {
  it('a warning from the first plan survives an edit', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [{ ref: 'sound.music', action: 'keep' }] }))
    expect(plan.warnings.join(' ')).toMatch(/music/)
    const next = applyEdits(plan, [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }], brand)
    expect(next.warnings.join(' ')).toMatch(/music/)
  })
})

describe('M8 remake runs are observable', () => {
  it('the private instance keeps logs and trace spans (no logger:false)', () => {
    const src = readFileSync(join(import.meta.dirname, 'instance.ts'), 'utf8')
    expect(src).not.toMatch(/logger:\s*false/)
    expect(src).toMatch(/observability:\s*new Observability/)
  })
})
