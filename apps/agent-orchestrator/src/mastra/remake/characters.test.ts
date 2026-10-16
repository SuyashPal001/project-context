// Other people the story needs (user, 2026-10-16): the metro reel's girl in the train window was never
// cast, so the image model gave her the lead's face (or left her out). The breakdown now lists the other
// characters, the plan swaps each for a new person, each gets one portrait after the lead is picked,
// and every still while they are on screen is given that portrait.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { normalizeOverview } from '../tools/videoBreakdown/watchVideo.js'
import { writePlan, planRefs, referenceOf } from './plan.js'
import { remakeLooks } from './looks.js'
import { charactersAt, stillPrompt, stillGateInput } from './prompts.js'
import { boardPrompt } from './board.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda' }
const girl = { who: 'young woman seated inside the train', when: '0:05 - 0:09.5', where: 'behind the train window' }
const withGirl = () => { const b = breakdown({ overview: { ...breakdown().overview, characters: [girl] } } as never); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }

describe('the breakdown and plan know the other characters', () => {
  it('the overview keeps each character with who, when and where', () => {
    expect(normalizeOverview({ characters: [girl, { who: '' }, 'x'] } as never).characters).toEqual([girl])
  })
  it('each character is a plan line, always a new person', async () => {
    const b = withGirl()
    expect(planRefs(b, remakeLooks(b)).find((r) => r.ref === 'characters[0]')).toEqual({ ref: 'characters[0]', what: girl.who })
    const p = await writePlan(b, brand, vi.fn().mockResolvedValue({ lines: [{ ref: 'characters[0]', action: 'keep' }] }))
    expect(p.lines.find((l) => l.ref === 'characters[0]')).toMatchObject({ action: 'swap', to: expect.stringMatching(/new person.*young woman seated inside the train/) })
    expect(referenceOf(b).characters).toEqual([girl])
  })
  it('a character is in a still only while on screen', async () => {
    const p = await writePlan(withGirl(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    expect(charactersAt(p, 2)).toEqual([])
    expect(charactersAt(p, 6).map((c) => c.i)).toEqual([0])
  })
})

describe('the still words name the character by image', () => {
  it('a still while she is on screen says which image she is; the check knows she comes from an image', async () => {
    const p = await writePlan(withGirl(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = { ...p.looks[1], guideStartS: 6 }
    const prompt = stillPrompt(p, look, 'start', brand, false, new Map([[0, 3]]))
    expect(prompt).toMatch(/The young woman seated inside the train is the person in image 3: same face and hair; not the person in the first image\./)
    expect(stillGateInput(p, look, 'start', prompt, new Map([[0, 3]])).planLine).toMatch(/characters\[0\]: swap to .*\(given by image 3, not described in words\)/)
    expect(stillPrompt(p, look, 'start', brand, false)).not.toMatch(/image 3/) // no portrait: no line
  })
  it('a board photo names her for that photo only', async () => {
    const p = await writePlan(withGirl(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const look = { ...p.looks[1], guideStartS: 4.5, guideEndS: 6 }
    const prompt = boardPrompt(p, [{ look, kind: 'start' }, { look, kind: 'end' }], new Map([[0, 3]]))
    expect(prompt).toMatch(/Photo 2:.*The young woman seated inside the train is the person in image 3/)
    expect(prompt.split('Photo 2:')[0]).not.toMatch(/image 3/)
  })
})

describe('the people check counts the characters in view', () => {
  it('a still expecting the lead and one character passes with 2 people', async () => {
    const look = remakeLooks(breakdown())[0]
    const img = { data: 'AA', mime: 'image/jpeg' }
    const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img } }
    const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['sheet', 'guide', 'girl'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, people: 2 }
    const deps = {
      ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x'), upload: vi.fn(),
      generateStill: vi.fn().mockResolvedValue({ fileId: 'still-1', creditsUsedMicro: '100' }),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 2, no_person: false, main: look.start }),
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: [] }),
    } as unknown as RemakeDeps
    const r = await makeStill(job, ctx, deps)
    expect(r.result.status).toBe('passed')
  })
})

describe('the workflow casts each character once and gives the portrait to her stills', () => {
  const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
  let made = 0
  beforeEach(() => { made = 0; setRemakeStorageForTests(new InMemoryStore()) })
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  it('one gated portrait per character at slot 2; stills while she is on screen get it', async () => {
    const b = withGirl()
    const generateStill = vi.fn().mockImplementation(async (input: { title: string }) => ({ fileId: /character/i.test(input.title) ? 'girl-portrait' : `img-${++made}`, creditsUsedMicro: '100' }))
    const promptGate = vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] })
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never, promptGate,
      fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }), localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
      upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)
    const run = await w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
    const resume = async (step: string, data: unknown) => (await ((await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)).createRun({ runId: run.runId })).resume({ step, resumeData: data, requestContext: rc() })
    await resume('plan', { decision: 'approve' })
    await resume('cast', { pick: 1 })
    const portrait = generateStill.mock.calls.find((c) => /character/i.test(c[0].title))!
    expect(portrait[2]).toBe(2)
    // Metro run: the check read a plain studio portrait as contradicting "looking at her phone in the train".
    expect(promptGate.mock.calls.some((c) => /casting portrait.*the scene, pose and expression come later/.test(c[0].planLine))).toBe(true)
    const stills = generateStill.mock.calls.filter((c) => /look \d (start|end) still/.test(c[0].title))
    const withHer = stills.filter((c) => (c[0].referenceFileIds as string[]).includes('girl-portrait')).map((c) => c[0].title)
    expect(withHer).toEqual(['Remake look 2 end still'])  // look 2 end (9.5s): she is on screen 5-9.5s; look 1 (0.2s) and look 2 start (4.6s) not
  }, 30_000)
})

describe('the cost estimate counts each character portrait', () => {
  it('one more image per cast character', async () => {
    const { estimateCost } = await import('./cost.js')
    const p = await writePlan(withGirl(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const without = { ...p, lines: p.lines.map((l) => (l.ref === 'characters[0]' ? { ...l, action: 'drop' as const } : l)) }
    expect(estimateCost(p, { castProvided: false, microEach: 1n }).images - estimateCost(without, { castProvided: false, microEach: 1n }).images).toBe(1)
  })
})
