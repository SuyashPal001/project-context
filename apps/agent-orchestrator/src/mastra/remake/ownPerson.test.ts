// A person the customer brings (castFileId) skipped the reference sheet, which is only made after a pick
// from the casting sheet, so their face held less well across stills and clips than a picked person's
// (fan reel on the real workflow, 2026-10-16). They now get the same sheet.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('a person the customer brings gets a reference sheet', () => {
  it('the sheet is made from their photo and the stills use it as the person', async () => {
    setRemakeStorageForTests(new InMemoryStore())
    const b = breakdown()
    let made = 0
    const generateStill = vi.fn().mockImplementation(async (input: { title: string }) => ({ fileId: /reference sheet/i.test(input.title) ? 'ref-sheet' : `img-${++made}`, creditsUsedMicro: '100' }))
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }), localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
      upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    const run = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own-person' }, requestContext: rc() })
    await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: run.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
    const sheet = generateStill.mock.calls.find((c) => /reference sheet/i.test(c[0].title))
    expect(sheet?.[0].referenceFileIds).toEqual(['own-person'])
    const stills = generateStill.mock.calls.filter((c) => /still|board/i.test(c[0].title))
    expect(stills.length).toBeGreaterThan(0)
    // the first still of a place is drawn from the sheet; the rest there are edits of it (edit chain, 2026-10-16)
    expect((stills[0][0].referenceFileIds as string[])[0]).toBe('ref-sheet')
  }, 30_000)
})
