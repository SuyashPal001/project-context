// The original's frame is every remake photo's pose reference, and its actress's face leaked into ours: our
// woman drifted from the approved sheet toward her (fan run real15, 2026-10-17). The image model gets the
// frame with the face blurred; the checks still measure the untouched frame.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('the original\'s face never reaches the image model', () => {
  it('stills get the face-hidden frame; the checks read the untouched one', async () => {
    setRemakeStorageForTests(new InMemoryStore())
    const b = breakdown()
    const calls: Array<{ title: string; referenceFileIds?: string[] }> = []
    const ffmpeg = vi.fn().mockResolvedValue(undefined)
    const poseImage = vi.fn(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start, ...(/guide-\d-(start|end)\.jpg$/.test(p) ? { head: [0.4, 0.2, 0.6, 0.35] } : {}) }))
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }),
      generateStill: vi.fn(async (input: { title: string; referenceFileIds?: string[] }) => { calls.push(input); return { fileId: /reference sheet/i.test(input.title) ? 'ref-sheet' : input.title.replace(/\W+/g, '-'), creditsUsedMicro: '100' } }) as never,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
      upload: vi.fn(async (_t: string, _key: string, name: string) => `up:${name}`),
      poseImage, stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null),
      sameSetting: vi.fn().mockResolvedValue({ same: true, differs: '' }),
      ffmpeg, readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    const r = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
    await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand: { name: 'B', product: 'p' }, castFileId: 'own' }, requestContext: rc() })
    await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: r.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
    const first = calls.find((c) => c.title === 'Remake look 1 start still')!
    expect(first.referenceFileIds).toContain('up:Remake look 1 start guide (face hidden).jpg')
    expect(first.referenceFileIds).not.toContain('up:Remake look 1 start guide.jpg')
    expect(ffmpeg.mock.calls.some((c) => String(c[0].join(' ')).includes('boxblur'))).toBe(true)
    // the framing and pose checks read the untouched frame
    expect(poseImage.mock.calls.some((c) => c[0] === '/m/up:Remake look 1 start guide.jpg')).toBe(true)
  }, 30_000)
})
