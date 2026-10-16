import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { setRemakeStorageForTests } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

vi.mock('../tools/videoBreakdown/breakDownVideo.js', async (orig) => ({
  ...(await orig<typeof import('../tools/videoBreakdown/breakDownVideo.js')>()),
  recentBreakdown: vi.fn(() => breakdown()),
  breakDownVideo: vi.fn(async () => breakdown()),
}))
vi.mock('../tools/generationApproval.js', async (orig) => ({ ...(await orig<typeof import('../tools/generationApproval.js')>()), shouldRequireApproval: vi.fn(async () => true) }))
const { remakeVideoTool, shapeRun } = await import('./remakeVideoTool.js')
const { recentBreakdown } = await import('../tools/videoBreakdown/breakDownVideo.js')

const ctx = (tenantId = 't1', conversationId = 'c1') => {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId, conversationId, sessionId: 's1', idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc } as never
}
const brand = { name: 'Bubbli', product: 'Bubbli soda' }
const exec = (input: Record<string, unknown>, c = ctx()) => remakeVideoTool.execute!(input as never, c) as Promise<Record<string, unknown>>

beforeEach(() => {
  setRemakeStorageForTests(new InMemoryStore())
  let n = 0
  setRemakeDeps({
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    imageRateMicro: async () => 1_000_000n,
    promptGate: async () => ({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '0' })),
  })
})
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('remake_video', () => {
  it('start returns the plan review with a cost estimate in credits', async () => {
    const r = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    expect(r).toMatchObject({ success: true, stage: 'plan_review', estimate: { images: 5, firstPassCredits: '5.00', maxCredits: '8.00' } })
    expect(r.runId).toBeTruthy()
  })
  it('start refuses a watch-only breakdown in plain words and creates no run', async () => {
    vi.mocked(recentBreakdown).mockReturnValueOnce(breakdown({ watch_only: true }))
    const r = await exec({ action: 'start', url: 'youtube.com/shorts/x', brand })
    expect(r.success).toBe(false)
    expect(String(r.error)).toMatch(/upload the video file/)
    expect(r.runId).toBeUndefined()
  })
  it('start needs the brand', async () => {
    expect(await exec({ action: 'start', url: 'instagram.com/p/x' })).toMatchObject({ success: false, error: 'brand_required' })
  })
  it('another conversation or tenant gets not_found for the same run', async () => {
    const { runId } = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    expect(await exec({ action: 'approve_plan', runId }, ctx('t1', 'other'))).toMatchObject({ success: false, error: 'not_found' })
    expect(await exec({ action: 'status', runId }, ctx('t2', 'c1'))).toMatchObject({ success: false, error: 'not_found' })
    expect(await exec({ action: 'status', runId: 'nope' })).toMatchObject({ success: false, error: 'not_found' })
  })
  it('edit_plan returns the edited plan; approve_plan returns the casting sheet; status re-reads it', async () => {
    const { runId } = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    const e = await exec({ action: 'edit_plan', runId, edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    expect((e.plan as { lines: Array<{ ref: string; to?: string }> }).lines.find((l) => l.ref === 'looks[1].outfit')?.to).toBe('green kurta')
    expect(await exec({ action: 'approve_plan', runId })).toMatchObject({ success: true, stage: 'cast_pick', sheetFileId: 'img-1' })
    expect(await exec({ action: 'status', runId })).toMatchObject({ success: true, stage: 'cast_pick', sheetFileId: 'img-1' })
  })
  it('asks for approval only before paid stages', async () => {
    const need = (action: string) => (remakeVideoTool.requireApproval as (i: unknown, c: unknown) => Promise<boolean>)({ action }, ctx())
    expect(await need('approve_plan')).toBe(true)
    expect(await need('pick_cast')).toBe(true)
    expect(await need('start')).toBe(false)
    expect(await need('edit_plan')).toBe(false)
  })

  it('approve_preview needs approval, priced as video; stop does not', async () => {
    const need = (action: string) => (remakeVideoTool.requireApproval as (i: unknown, c: unknown) => Promise<boolean>)({ action }, ctx())
    expect(await need('approve_preview')).toBe(true)
    expect(await need('stop')).toBe(false)
    const { shouldRequireApproval } = await import('../tools/generationApproval.js')
    expect(vi.mocked(shouldRequireApproval)).toHaveBeenCalledWith({ resourceType: 'video_generation', subject: 'google/veo-3.1-fast-generate-001' }, expect.anything())
  })
  it('shapes preview_review and final_ready', () => {
    expect(shapeRun('r', { status: 'suspended', steps: { preview: { suspendPayload: { stage: 'preview_review', previewFileId: 'p', stills: [], summary: { spentMicro: '0', wastedMicro: '0', failed: [], blocked: [] }, clipsEstimate: { clips: 2, firstPassMicro: '268000000', maxMicro: '468000000' } } } } }))
      .toMatchObject({ success: true, stage: 'preview_review', previewFileId: 'p', clipsEstimate: { clips: 2, firstPassCredits: '268.00', maxCredits: '468.00' } })
    expect(shapeRun('r', { status: 'success', result: { finalFileId: 'f', note: 'N', summary: { spentMicro: '1000000', wastedMicro: '0', failed: [], blocked: [] } } }))
      .toMatchObject({ success: true, stage: 'final_ready', finalFileId: 'f', note: 'N', summary: { spentCredits: '1.00' } })
    expect(shapeRun('r', { status: 'success', result: { finalFileId: null, previewFileId: 'p', note: '', stills: [], summary: { spentMicro: '0', wastedMicro: '0', failed: [], blocked: [] } } }))
      .toMatchObject({ success: true, stage: 'preview_ready', previewFileId: 'p' })
  })
})
