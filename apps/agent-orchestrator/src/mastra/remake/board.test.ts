// Stills from a photo board (user's pick after the metro + fan A/B, 2026-10-16): the stills of one outfit
// look are made as ONE image of 2-3 photos side by side (same person, same light across them, fewer paid
// images), cut apart free, then each photo goes through the same checks and one edit retry as a single
// still. Single stills stay the fallback: a look with one still, a blocked or failed board, a board that
// can't be cut. The board never says "storyboard" (the word drew a cartoon in the A/B).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { boardChunks, boardUnits, boardPrompt, boardGateInput, boardAspect, BOARD_SLOT } from './board.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { writePlan } from './plan.js'
import { remakeLooks } from './looks.js'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'
import type { RemakeLook } from './types.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda' }

describe('which stills share a board', () => {
  it('2-3 photos per board; more are split evenly, never leaving one alone', () => {
    expect([2, 3, 4, 5, 7].map(boardChunks)).toEqual([[2], [3], [2, 2], [3, 2], [3, 2, 2]])
  })
  const job = (n: number, ref: number, person = true) => ({ look: { n, ref, people: person ? 1 : 0 } as unknown as RemakeLook, kind: 'start' as const, person })
  it('stills of the same outfit look share a board; a look with one still is made alone', () => {
    const units = boardUnits([job(1, 0), job(2, 1), job(3, 1), job(4, 1)], { aspectRatio: '9:16', product: false })
    expect(units.map((u) => u.map((j) => j.look.n))).toEqual([[1], [2, 3, 4]])
  })
  it('no boards for a landscape reel, a product photo, or stills with no person', () => {
    const jobs = [job(1, 0), job(2, 0)]
    expect(boardUnits(jobs, { aspectRatio: '16:9', product: false })).toHaveLength(2)
    expect(boardUnits(jobs, { aspectRatio: '9:16', product: true })).toHaveLength(2)
    expect(boardUnits([job(1, 0, false), job(2, 0, false)], { aspectRatio: '9:16', product: false })).toHaveLength(2)
  })
  it('the board shape fits its photos', () => {
    expect([boardAspect(2), boardAspect(3)]).toEqual(['1:1', '16:9'])
  })
})

describe('the board prompt', () => {
  it('asks for real photos side by side, each copying its own frame, built from the still plan', async () => {
    const p = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = p.looks[1]
    const prompt = boardPrompt(p, [{ look, kind: 'start' }, { look, kind: 'end' }])
    expect(prompt).toMatch(/^2 real photographs side by side/)
    expect(prompt).not.toMatch(/storyboard/i)
    expect(prompt).toMatch(/The person in every photo is the person in the first image/)
    expect(prompt).toMatch(/Photo 1: Pose: sits\..*Photo 2: Pose: stands\./)
    expect(prompt.match(/Setting:/g)).toHaveLength(1)
  })
  it('the check input names every photo and the person comes from the image', async () => {
    const p = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = p.looks[1]
    const g = boardGateInput(p, [{ look, kind: 'start' }, { look, kind: 'end' }], 'X')
    expect(g.planLine).toMatch(/one image of 2 photos side by side: look 2 start still, look 2 end still/)
    expect(g.planLine).toMatch(/not described in words/)
    expect(g.startFrameObjects).toEqual(['remote'])
  })
})

describe('a board photo is the first try of its still', () => {
  const img = { data: 'AA', mime: 'image/jpeg' }
  const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img } }
  const look = remakeLooks(breakdown())[0]
  const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['sheet', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
  const deps = (checks: Array<{ passed: boolean; reasons: string[] }>) => {
    const stillChecks = vi.fn()
    for (const c of checks) stillChecks.mockResolvedValueOnce({ ...c, warnings: [] })
    return {
      ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x'), upload: vi.fn(),
      generateStill: vi.fn().mockResolvedValue({ fileId: 'edit-1', creditsUsedMicro: '100' }),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: look.start }),
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      stillChecks, ffmpeg: vi.fn(), readFile: vi.fn(), renderPreview: vi.fn(), imageRateMicro: vi.fn(),
    } as unknown as RemakeDeps
  }
  it('a passing photo costs no extra call; its try shows its share of the board', async () => {
    const d = deps([{ passed: true, reasons: [] }])
    const r = await makeStill(job, ctx, d, { fileId: 'panel-1', creditsMicro: '50' })
    expect(d.generateStill).not.toHaveBeenCalled()
    expect(d.promptGate).not.toHaveBeenCalled()
    expect(r.result).toMatchObject({ fileId: 'panel-1', status: 'passed', tries: [{ fileId: 'panel-1', kept: true, why: [], creditsMicro: '50' }] })
    expect(r.ledger).toEqual([{ item: 'look 1 start still', attempt: 0, creditsMicro: '0', outcome: 'kept' }])
  })
  it('a failing photo is fixed by one edit of that photo', async () => {
    const d = deps([{ passed: false, reasons: ['an object appears twice (two remotes)'] }, { passed: true, reasons: [] }])
    const r = await makeStill(job, ctx, d, { fileId: 'panel-1', creditsMicro: '50' })
    const call = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.referenceFileIds).toEqual(['panel-1', 'sheet'])
    expect(call.prompt).toMatch(/^Edit the first image/)
    expect(r.result).toMatchObject({ fileId: 'edit-1', status: 'passed' })
  })
})

describe('the workflow makes boards, with single stills as the fallback', () => {
  const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
  let made = 0
  beforeEach(() => { made = 0; setRemakeStorageForTests(new InMemoryStore()) })
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  type Steps = { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }
  const isBoard = (input: { prompt: string }) => /real photographs side by side/.test(input.prompt)
  async function run(o: Partial<RemakeDeps>) {
    const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }),
      fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }),
      localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
      upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/preview.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
      ...o,
    })
    const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)
    const r = await w.createRun()
    await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
    const resume = async (step: string, resumeData: unknown) => (await ((await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)).createRun({ runId: r.runId })).resume({ step, resumeData, requestContext: rc() })
    await resume('plan', { decision: 'approve' })
    return (await resume('cast', { pick: 1 })) as unknown as Steps
  }
  it('look 2 start and end come from one board; look 1 is a single still', async () => {
    const generateStill = vi.fn().mockImplementation(async (input: { prompt: string }) => ({ fileId: isBoard(input) ? 'board-1' : `img-${++made}`, creditsUsedMicro: '100' }))
    const cutBoard = vi.fn().mockResolvedValue(['panel-a', 'panel-b'])
    const out = await run({ generateStill: generateStill as never, cutBoard })
    const boards = generateStill.mock.calls.filter((c) => isBoard(c[0]))
    expect(boards).toHaveLength(1)
    expect(boards[0][2]).toBe(BOARD_SLOT)
    expect(boards[0][0]).toMatchObject({ aspectRatio: '1:1', imageSize: '2K' })
    expect(cutBoard).toHaveBeenCalledWith('board-1', 2, '9:16', expect.anything())
    const stills = out.steps.preview.suspendPayload!.stills as Array<{ look: number; kind: string; fileId: string }>
    expect(stills.filter((s) => s.look === 2).map((s) => s.fileId)).toEqual(['panel-a', 'panel-b'])
    expect(out.steps.preview.suspendPayload!.summary).toMatchObject({ spentMicro: '400' }) // casting + sheet + look 1 + one board
  }, 30_000)
  it('a board that can not be cut falls back to single stills', async () => {
    const generateStill = vi.fn().mockImplementation(async (input: { prompt: string }) => ({ fileId: isBoard(input) ? 'board-1' : `img-${++made}`, creditsUsedMicro: '100' }))
    const out = await run({ generateStill: generateStill as never, cutBoard: vi.fn().mockResolvedValue(null) })
    const stills = out.steps.preview.suspendPayload!.stills as Array<{ look: number; fileId: string; status: string }>
    expect(stills.filter((s) => s.look === 2).every((s) => s.status === 'passed' && /^img-/.test(s.fileId))).toBe(true)
  }, 30_000)
  it('a board stopped by the prompt check costs nothing and falls back to single stills', async () => {
    const generateStill = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const promptGate = vi.fn().mockImplementation(async (input: { prompt: string }) => ({ name: 'prompt', status: /real photographs side by side/.test(input.prompt) ? 'fail' : 'pass', reason: 'x', evidenceTimes: [] }))
    await run({ generateStill: generateStill as never, promptGate, cutBoard: vi.fn() })
    expect(generateStill.mock.calls.some((c) => isBoard(c[0]))).toBe(false)
    expect(generateStill.mock.calls.length).toBe(5) // casting + sheet + 3 single stills
  }, 30_000)
})
