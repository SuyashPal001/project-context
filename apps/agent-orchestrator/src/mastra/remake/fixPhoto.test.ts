// The user can fix one photo at the preview (user, 2026-10-17: the fan run's look 3 end still had the
// dupatta over her head, and the preview could only be approved or stopped). A fix is an EDIT of that
// photo, checked like any still, and the preview comes back with it.
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

async function atPreview() {
  setRemakeStorageForTests(new InMemoryStore())
  const b = breakdown()
  let n = 0
  const generateStill = vi.fn(async (input: { title: string; prompt: string; referenceFileIds?: string[] }) => ({ fileId: /reference sheet/i.test(input.title) ? 'ref-sheet' : `img-${++n}`, creditsUsedMicro: '100' }))
  const stillChecks = vi.fn().mockResolvedValue({ passed: true, reasons: [] })
  const renderPreview = vi.fn().mockResolvedValue('/m/p.mp4')
  setRemakeDeps({
    ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never,
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
    stillChecks, cutBoard: vi.fn().mockResolvedValue(null),
    sameSetting: vi.fn().mockResolvedValue({ same: true, differs: '' }),
    ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview,
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
  })
  const r = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
  await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own' }, requestContext: rc() })
  const resume = async (step: string, data: unknown) => (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: r.runId })).resume({ step, resumeData: data, requestContext: rc() })
  const first = await resume('plan', { decision: 'approve' })
  const stills = (first as unknown as { steps: Record<string, { suspendPayload?: { stills: Array<{ look: number; kind: string; fileId: string }> } }> }).steps.preview.suspendPayload!.stills
  return { generateStill, stillChecks, renderPreview, resume, runId: r.runId, stills }
}

describe('fixing one photo at the preview', () => {
  it('edits that photo with the user\'s words and shows the preview again with it', async () => {
    const { generateStill, renderPreview, resume, runId, stills } = await atPreview()
    const old = stills.find((s) => s.look === 1 && s.kind === 'start')!.fileId
    const r = await resume('preview', { decision: 'fix', fixes: [{ look: 1, kind: 'start', change: 'the dupatta on her shoulders, not over her head' }] })
    const edit = [...generateStill.mock.calls].reverse().find((c) => c[0].referenceFileIds?.[0] === old)!
    expect(edit[0].prompt).toMatch(/^Edit the first image\. Change only this: the dupatta on her shoulders, not over her head\./)
    expect(r.status).toBe('suspended')
    const shaped = shapeRun(runId, r as never) as unknown as { stage: string; stills: Array<{ look: number; kind: string; fileId: string }> }
    expect(shaped.stage).toBe('preview_review')
    const now = shaped.stills.find((s) => s.look === 1 && s.kind === 'start')!.fileId
    expect(now).toBe((await generateStill.mock.results[generateStill.mock.calls.indexOf(edit)].value as { fileId: string }).fileId)
    expect(now).not.toBe(old)
    expect(renderPreview).toHaveBeenCalledTimes(2)
  }, 30_000)
  it('the fixed photo\'s face is checked against the photo it was edited from', async () => {
    const { stillChecks, resume, stills } = await atPreview()
    const old = stills.find((s) => s.look === 1 && s.kind === 'start')!.fileId
    stillChecks.mockClear()
    await resume('preview', { decision: 'fix', fixes: [{ look: 1, kind: 'start', change: 'arms by her sides' }] })
    expect((stillChecks.mock.calls[0][2] as { lead: { data: string } }).lead.data).toBe(old)
  }, 30_000)
  it('approving after a fix animates the fixed photo, and its cost is counted', async () => {
    const { generateStill, resume, stills } = await atPreview()
    const old = stills.find((s) => s.look === 1 && s.kind === 'start')!.fileId
    await resume('preview', { decision: 'fix', fixes: [{ look: 1, kind: 'start', change: 'arms by her sides' }] })
    const fixedId = (await generateStill.mock.results.at(-1)!.value as { fileId: string }).fileId
    const r = await resume('preview', { decision: 'approve' })
    const out = (r as unknown as { steps: Record<string, { output?: { stills: Array<{ look: number; kind: string; fileId: string }>; ledger: Array<{ item: string }> } }> }).steps.preview.output!
    expect(out.stills.find((s) => s.look === 1 && s.kind === 'start')!.fileId).toBe(fixedId)
    expect(fixedId).not.toBe(old)
    expect(out.ledger.some((l) => l.item === 'look 1 start still change')).toBe(true)
  }, 30_000)
})
