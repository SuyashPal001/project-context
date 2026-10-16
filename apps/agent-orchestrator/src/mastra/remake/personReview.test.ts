// The user approves the person before any still is made (user, 2026-10-16: "the sheet should be finalised
// by the user — is this the look you want? if so, create from there", the way Higgsfield does it). A change
// is an edit of the sheet, never a new person.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { shapeRun } from './remakeVideoTool.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

async function setup() {
  setRemakeStorageForTests(new InMemoryStore())
  const b = breakdown()
  let n = 0
  const generateStill = vi.fn(async (input: { title: string; prompt: string; referenceFileIds?: string[] }) => ({ fileId: /reference sheet/i.test(input.title) ? `sheet-${++n}` : `img-${++n}`, creditsUsedMicro: '100' }))
  setRemakeDeps({
    ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never,
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null),
    sameSetting: vi.fn().mockResolvedValue({ same: true, differs: '' }),
    ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
  })
  const r = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
  await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own', reviewPerson: true }, requestContext: rc() })
  const resume = async (step: string, data: unknown) => (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: r.runId })).resume({ step, resumeData: data, requestContext: rc() })
  return { generateStill, resume, runId: r.runId }
}
const stills = (g: ReturnType<typeof vi.fn>) => g.mock.calls.filter((c) => / still$/.test(c[0].title))

describe('the person is approved before any still', () => {
  it('stops after the sheet with it for review; no still is made yet', async () => {
    const { generateStill, resume, runId } = await setup()
    const r = await resume('plan', { decision: 'approve' })
    expect(r.status).toBe('suspended')
    expect(shapeRun(runId, r as never)).toMatchObject({ stage: 'person_review', sheetFileId: 'sheet-1' })
    expect(stills(generateStill)).toHaveLength(0)
  }, 30_000)
  it('a change edits the sheet (same person) and asks again', async () => {
    const { generateStill, resume, runId } = await setup()
    await resume('plan', { decision: 'approve' })
    const r = await resume('cast', { decision: 'edit', change: 'longer hair' })
    const edit = generateStill.mock.calls.find((c) => /reference sheet/i.test(c[0].title) && c[0].referenceFileIds?.[0] === 'sheet-1')!
    expect(edit[0].prompt).toMatch(/^Edit this character reference sheet\. Change only: longer hair\./)
    expect(edit[0].prompt).toMatch(/same face/)
    expect(shapeRun(runId, r as never)).toMatchObject({ stage: 'person_review', sheetFileId: 'sheet-2' })
    expect(stills(generateStill)).toHaveLength(0)
  }, 30_000)
  it('approving makes the stills from the approved sheet', async () => {
    const { generateStill, resume } = await setup()
    await resume('plan', { decision: 'approve' })
    await resume('cast', { decision: 'edit', change: 'longer hair' })
    const r = await resume('cast', { decision: 'approve' })
    expect(r.status).toBe('suspended') // on to the preview review
    expect(stills(generateStill)[0][0].referenceFileIds[0]).toBe('sheet-2')
  }, 30_000)
})
