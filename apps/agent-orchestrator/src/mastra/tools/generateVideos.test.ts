import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(),
  resolveRate: vi.fn(),
  isUnlimited: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

import { generateVideos } from './generateVideos.js'
import { uploadGeneratedFile } from '../../persistence.js'
import { stableToolCallId } from '../../credits.js'

function batchCtx() {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'tc-b' } } as never
}
const item = (prompt: string) => ({ mode: 'text_to_video' as const, prompt, aspectRatio: '16:9' as const, durationSeconds: 8 })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 100_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateVideos tool', () => {
  it('generates every item, charging each under its own index-suffixed key', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'f0', name: 'a.mp4', type: 'video/mp4', size: 3 })
      .mockResolvedValueOnce({ fileId: 'f1', name: 'b.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideos.execute!({ items: [item('one'), item('two')] } as never, batchCtx()) as { results: Array<{ index: number; fileId?: string }>; succeeded: number; failed: number }

    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.results.map((r) => r.index)).toEqual([0, 1])
    expect(result.results.map((r) => r.fileId).sort()).toEqual(['f0', 'f1'])
    const keys = spendCredits.mock.calls.map((c) => c[0].key).sort()
    expect(keys).toEqual([`video:c1:${stableToolCallId('tc-b')}:0`, `video:c1:${stableToolCallId('tc-b')}:1`])
  })

  it('refuses an invalid item without charging it while its sibling still generates', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'b.mp4', type: 'video/mp4', size: 3 })
    const bad = { ...item('missing the tag'), identityAnchor: { terseTag: 'TAG-X', styleLock: 'LOCK-Y' } }

    const result = await generateVideos.execute!({ items: [bad, item('fine')] } as never, batchCtx()) as { results: Array<Record<string, unknown>>; succeeded: number; failed: number }

    expect(result.results[0]).toMatchObject({ index: 0, refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
    expect(result.results[1]).toMatchObject({ index: 1, fileId: 'f1' })
    expect(result).toMatchObject({ succeeded: 1, failed: 1 })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: `video:c1:${stableToolCallId('tc-b')}:1` }))
  })

  it('refunds only the failed item when one gateway call fails', async () => {
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f-ok', name: 'b.mp4', type: 'video/mp4', size: 3 })
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideos.execute!({ items: [item('one'), item('two')] } as never, batchCtx()) as { succeeded: number; failed: number }

    expect(result).toMatchObject({ succeeded: 1, failed: 1 })
    const refunds = spendCredits.mock.calls.filter((c) => c[0].kind === 'refund')
    expect(refunds).toHaveLength(1)
  })

  it('rejects an empty batch and a batch over MAX_BATCH_ITEMS', () => {
    const schema = generateVideos.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4'), item('5')] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4')] }).success).toBe(true)
  })

  it('emits batch_item_progress per item as each settles, not just at the end', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'f0', name: 'a.mp4', type: 'video/mp4', size: 3 })
      .mockResolvedValueOnce({ fileId: 'f1', name: 'b.mp4', type: 'video/mp4', size: 3 })
    const sendEvent = vi.fn()
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok', sendEvent })) requestContext.set(k, v)
    const ctx = { requestContext, agent: { toolCallId: 'tc-b' } } as never

    await generateVideos.execute!({ items: [item('one'), item('two')] } as never, ctx)

    // generation_started (once, when execute begins) is separate from the per-item progress events.
    expect(sendEvent.mock.calls.filter((c) => c[0] === 'generation_started')).toHaveLength(1)
    const progress = sendEvent.mock.calls.filter((c) => c[0] === 'batch_item_progress')
    expect(progress).toHaveLength(2)
    const calls = progress.map((c) => c[1]).sort((a, b) => a.index - b.index)
    expect(calls).toEqual([
      { toolCallId: 'tc-b', index: 0, total: 2, status: 'done', fileId: 'f0' },
      { toolCallId: 'tc-b', index: 1, total: 2, status: 'done', fileId: 'f1' },
    ])
  })

  it('requireApproval delegates to shouldRequireApproval with video_generation and the video model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    const requireApproval = generateVideos.requireApproval as unknown as (input: unknown, ctx: unknown) => Promise<boolean>
    const needs = await requireApproval({ items: [item('x')] }, ctx)
    expect(needs).toBe(true)
    expect(shouldRequireApproval).toHaveBeenCalledWith({ resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash' }, ctx)
  })
})
