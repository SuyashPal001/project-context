import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'
import { remakeStillChecks } from './stillChecks.js'

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
    cutBoard: vi.fn(async (_f: string, n: number) => Array.from({ length: n }, (_, k) => `panel-${k + 1}`)),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
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

// Face consistency is HARD (user, 2026-10-16). The remake used only a small front crop of the casting
// panel: no character sheet, no anchor still. Now: after the pick, one reference sheet of the chosen
// person (front, 3/4, profile, full body) leads every still and is the face check's reference; the
// first person still is made alone and, once kept, is passed to the rest (same person, same light).
describe('identity: reference sheet + anchor still', () => {
  const gen = () => vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
  async function toPreview(o: Partial<RemakeDeps> = {}, input: Record<string, unknown> = {}) {
    const g = (o.generateStill as ReturnType<typeof vi.fn>) ?? gen()
    const { runId } = await start({ ...o, generateStill: g as never }, input)
    await resume(runId, 'plan', { decision: 'approve' })
    const done = await resume(runId, 'cast', { pick: 1 })
    return { g, out: (done as unknown as Steps).steps.preview.suspendPayload! }
  }
  it('makes a reference sheet of the chosen person right after the pick, at its own slot', async () => {
    const { g, out } = await toPreview()
    const [input, , slot] = g.mock.calls[1]
    expect(input.prompt).toMatch(/reference sheet/i)
    expect(input.referenceFileIds).toEqual([expect.stringMatching(/^up:/)])
    expect(slot).toBe(1)
    expect(out.summary).toMatchObject({ spentMicro: '400' }) // casting sheet + reference sheet + look 1 still + one board for look 2's two stills
  })
  it('every still and board leads with the reference sheet; the first still is the anchor for single stills', async () => {
    // Look 1's still is made alone (the anchor); look 2's two stills are one board, which holds the
    // person across its own photos. A single still after the anchor gets it as image 3.
    const { g } = await toPreview()
    const calls = g.mock.calls.slice(2).map((c) => c[0] as { prompt: string; referenceFileIds: string[] })
    expect(calls.every((c) => c.referenceFileIds[0] === 'img-2')).toBe(true)
    expect(calls[0].referenceFileIds).toHaveLength(2)   // the anchor is made alone
    expect(calls[1].prompt).toMatch(/real photographs side by side/)
  })
  it('a single still after the anchor gets it as the third image', async () => {
    const { g } = await toPreview({ cutBoard: vi.fn().mockResolvedValue(null) })
    const singles = g.mock.calls.slice(2).map((c) => c[0] as { prompt: string; referenceFileIds: string[] }).filter((c) => !/side by side/.test(c.prompt))
    expect(singles.slice(1).every((c) => c.referenceFileIds[2] === 'img-3')).toBe(true)
  })
  it('the face is checked against the reference sheet', async () => {
    const fetchImage = vi.fn().mockImplementation(async (id: string) => ({ data: id, mime: 'image/jpeg' }))
    const stillChecks = vi.fn().mockResolvedValue({ passed: true, reasons: [] })
    await toPreview({ fetchImage, stillChecks })
    expect(stillChecks.mock.calls.every((c) => c[2].lead?.data === 'img-2')).toBe(true)
  })
  it('a failed reference sheet never ends the run: stills use the cropped portrait', async () => {
    const g: ReturnType<typeof vi.fn> = vi.fn().mockImplementation(async (input: { prompt: string }) => (/reference sheet/i.test(input.prompt) ? { refused: true, creditsUsedMicro: '0' } : { fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const { out } = await toPreview({ generateStill: g as never })
    expect((out.stills as Array<{ status: string }>).every((s) => s.status === 'passed')).toBe(true)
    expect(g.mock.calls.slice(2).every((c) => /^up:/.test(c[0].referenceFileIds[0]))).toBe(true)
  })
})

describe('the face check is hard again', () => {
  it('a different face fails the still', async () => {
    const ask = vi.fn(async (parts: Array<{ text?: string }>) => {
      const q = parts.map((p) => ('text' in p ? p.text : '')).join(' ')
      if (/duplicate_object/.test(q)) return { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, drawn: false, what: '' }
      if (/same face/.test(q)) return { lead_present: true, same_face: false, why: 'different nose' }
      return { others: [] }
    })
    const r = await remakeStillChecks(ask as never, { data: 'A', mime: 'image/jpeg' }, { lead: { data: 'L', mime: 'image/jpeg' }, leadInShot: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/face/)
  })
})

describe('the reference sheet follows the TVC continuity bible, minus the costume', () => {
  it('has the turnaround, face details, expressions and body poses; the outfit is not locked', async () => {
    const { REFERENCE_SHEET_PROMPT } = await import('./prompts.js')
    for (const part of [/FULL-BODY TURNAROUND/, /FACE & IDENTITY DETAILS/, /EXPRESSION SHEET/, /POSE & BODY LANGUAGE/, /DO NOT CHANGE/]) expect(REFERENCE_SHEET_PROMPT).toMatch(part)
    expect(REFERENCE_SHEET_PROMPT).not.toMatch(/COSTUME DETAILS|Costume ·|Jewellery ·/)
  })
  it('is made at 3:4 and 2K, like the TVC sheet', async () => {
    const g = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const { runId } = await start({ generateStill: g as never })
    await resume(runId, 'plan', { decision: 'approve' })
    await resume(runId, 'cast', { pick: 1 })
    expect(g.mock.calls[1][0]).toMatchObject({ aspectRatio: '3:4', imageSize: '2K' })
  })
})
