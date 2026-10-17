// Each look is directed like v12 was by hand (user, 2026-10-17: "acceptable not exceptional"; "she keeps the remote in
// her hand"): the photographer's direction read from the original's frames goes into the photos and the clips.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'
import { clipPrompt, clipGateInput } from './clipSpec.js'
import { writePlan } from './plan.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
const direction = { start: 'one hand resting on her chest, legs crossed at the ankles', moves: 'she slowly slides both legs to the image-right', objects: 'the black remote lies on the rug beside her left hand' }

describe('the photos are directed from the original', () => {
  it('a still says the direction\'s pose and where the objects rest', async () => {
    setRemakeStorageForTests(new InMemoryStore())
    const b = breakdown()
    const calls: Array<{ title: string; prompt: string }> = []
    const ask = vi.fn(async (parts: Array<{ text?: string }>) => (/how a photographer would direct/.test(parts.at(-1)?.text ?? '') ? direction : { lines: [] }))
    setRemakeDeps({
      ask: () => ask as never,
      generateStill: vi.fn(async (input: { title: string; prompt: string }) => { calls.push(input); return { fileId: input.title.replace(/\W+/g, '-'), creditsUsedMicro: '100' } }) as never,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
      upload: vi.fn(async (_t: string, _k: string, name: string) => `up:${name}`), sample: vi.fn(async (_p: string, times: number[]) => times.map((t) => ({ data: `f${t}`, mime: 'image/jpeg' }))),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null),
      sameSetting: vi.fn().mockResolvedValue({ same: true, differs: '' }),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    const r = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
    await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own' }, requestContext: rc() })
    const res = await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: r.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
    const first = calls.find((c) => c.title === 'Remake look 1 start still')!
    expect(first.prompt).toMatch(/Pose: one hand resting on her chest, legs crossed at the ankles\./)
    expect(first.prompt).toMatch(/the black remote lies on the rug beside her left hand/)
    const second = calls.find((c) => c.title === 'Remake look 2 start still')!
    expect(second.prompt).toMatch(/one hand resting on her chest/)
    const out = (res as unknown as { steps: Record<string, { suspendPayload?: unknown; output?: { directions?: Record<string, unknown> } }> }).steps.stills.output
    expect(out?.directions?.['1']).toEqual(direction)
  }, 30_000)
})

describe('the clips are directed from the original', () => {
  it('a person\'s clip says the direction\'s moves and where the objects rest, and the check knows them', async () => {
    const p = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const s = clipPrompt(p, p.looks[0], brand, 'omni', undefined, false, undefined, direction)
    expect(s).toMatch(/Then she slowly slides both legs to the right side of the image, and holds the pose\./)
    expect(s).toMatch(/The black remote lies on the rug beside her left hand and stays there\./)
    expect(clipGateInput(p, p.looks[0], s, undefined, undefined, direction).planLine).toMatch(/the photographer's direction read from the original look/)
  })
})
