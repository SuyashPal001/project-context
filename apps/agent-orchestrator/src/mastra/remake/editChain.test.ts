// The remake makes its person stills the v12 way (tools/nextShot): the first still of a place is fresh;
// every later still in that place is an edit of it (outfit, styling and pose change; face, hair, room and
// camera stay); an end still is an edit of its own start (pose only). Fresh drawings per look drifted the
// face, hair, rug and camera on every fan-reel run (2026-10-16); the edit chain held all four looks.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

async function run(samePlace: boolean, styling?: string) {
  setRemakeStorageForTests(new InMemoryStore())
  const b = breakdown()
  if (styling) b.overview.looks = b.overview.looks.map((l) => ({ ...l, styling }))
  const calls: Array<{ title: string; prompt: string; referenceFileIds?: string[] }> = []
  const stillChecks = vi.fn().mockResolvedValue({ passed: true, reasons: [] })
  const generateStill = vi.fn(async (input: { title: string; prompt: string; referenceFileIds?: string[] }) => {
    calls.push(input)
    const id = /reference sheet/i.test(input.title) ? 'ref-sheet' : input.title.replace(/\W+/g, '-')
    return { fileId: id, creditsUsedMicro: '100' }
  })
  setRemakeDeps({
    ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never,
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
    stillChecks, cutBoard: vi.fn().mockResolvedValue(null),
    sameSetting: vi.fn().mockResolvedValue({ same: samePlace, differs: '' }),
    ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
  })
  const r = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
  await r.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own' }, requestContext: rc() })
  await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: r.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
  const still = (look: number, kind: string) => calls.find((c) => c.title === `Remake look ${look} ${kind} still`)
  return { calls, still, stillChecks }
}

describe('stills in one place are an edit chain', () => {
  it('look 1 is fresh from the person; look 2 edits look 1; an end still edits its own start', async () => {
    const { still } = await run(true)
    expect(still(1, 'start')!.referenceFileIds![0]).toBe('ref-sheet')
    expect(still(1, 'start')!.prompt).not.toMatch(/^Edit the first image/)
    const s2 = still(2, 'start')!
    expect(s2.referenceFileIds![0]).toBe('Remake-look-1-start-still')
    expect(s2.prompt).toMatch(/^Edit the first image\. Change only: \(1\) the outfit to blue suit; \(2\) the body pose/)
    const e2 = still(2, 'end')!
    expect(e2.referenceFileIds![0]).toBe('Remake-look-2-start-still')
    expect(e2.prompt).toMatch(/^Edit the first image\. Change only: \(1\) the body pose/)
  }, 30_000)
  it('an edited still\'s face is checked against the photo it was edited from', async () => {
    // fan run real6 (2026-10-17): looks 2 and 4 kept look 1's face, but a tiny face lying on the floor
    // compared against the big sheet photo read as "a different person" on every try, and both were dropped.
    const { stillChecks } = await run(true)
    const call = (id: string) => stillChecks.mock.calls.find((c) => (c[1] as { data: string }).data === id)!
    expect((call('Remake-look-2-start-still')[2] as { lead: { data: string } }).lead.data).toBe('Remake-look-1-start-still')
    expect((call('Remake-look-2-end-still')[2] as { lead: { data: string } }).lead.data).toBe('Remake-look-2-start-still')
    expect((call('Remake-look-1-start-still')[2] as { lead: { data: string } }).lead.data).toBe('ref-sheet')
  }, 30_000)
  it('a look in another place (the original changes place) starts fresh from the person', async () => {
    const { still } = await run(false)
    expect(still(2, 'start')!.referenceFileIds![0]).toBe('ref-sheet')
    expect(still(2, 'start')!.prompt).not.toMatch(/^Edit the first image/)
  }, 30_000)
  it('no styled-person pictures; the person sheet carries the reel\'s styling', async () => {
    const { calls } = await run(true, 'hair worn open, long and wavy')
    expect(calls.some((c) => /styled person/i.test(c.title))).toBe(false)
    expect(calls.find((c) => /reference sheet/i.test(c.title))!.prompt).toMatch(/Styling in every panel: hair worn open, long and wavy\./)
  }, 30_000)
})
