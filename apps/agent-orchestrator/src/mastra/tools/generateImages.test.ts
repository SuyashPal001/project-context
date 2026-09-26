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

import { generateImages } from './generateImages.js'
import { stableToolCallId } from '../../credits.js'
import { uploadGeneratedFile } from '../../persistence.js'

function batchCtx() {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'tc-b' } } as never
}
const imgItem = (prompt: string) => ({ prompt })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 100_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateImages tool', () => {
  it('generates every item, charging each under its own index-suffixed key', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'i0', name: 'a.png', type: 'image/png', size: 3 })
      .mockResolvedValueOnce({ fileId: 'i1', name: 'b.png', type: 'image/png', size: 3 })

    const result = await generateImages.execute!({ items: [imgItem('one'), imgItem('two')] } as never, batchCtx()) as { succeeded: number; results: Array<{ fileId?: string }> }

    expect(result.succeeded).toBe(2)
    expect(result.results.map((r) => r.fileId).sort()).toEqual(['i0', 'i1'])
    expect(spendCredits.mock.calls.map((c) => c[0].key).sort()).toEqual([`image:c1:${stableToolCallId('tc-b')}:0`, `image:c1:${stableToolCallId('tc-b')}:1`])
  })

  it('refunds an item whose gateway call is refused (image charges before the call)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'POLICY' }), { status: 200 })) as unknown as typeof fetch
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-50000', expires_at: null }] }) })

    const result = await generateImages.execute!({ items: [imgItem('one')] } as never, batchCtx()) as { failed: number; results: Array<Record<string, unknown>> }

    expect(result.failed).toBe(1)
    expect(result.results[0]).toMatchObject({ index: 0, refused: true, refusalReason: 'POLICY' })
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund' }))
  })

  it('emits batch_item_progress per item as each settles, not just at the end', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'i0', name: 'a.png', type: 'image/png', size: 3 })
      .mockResolvedValueOnce({ fileId: 'i1', name: 'b.png', type: 'image/png', size: 3 })
    const sendEvent = vi.fn()
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok', sendEvent })) requestContext.set(k, v)
    const ctx = { requestContext, agent: { toolCallId: 'tc-b' } } as never

    await generateImages.execute!({ items: [imgItem('one'), imgItem('two')] } as never, ctx)

    // generation_started (once, when execute begins) is separate from the per-item progress events.
    expect(sendEvent.mock.calls.filter((c) => c[0] === 'generation_started')).toHaveLength(1)
    const progress = sendEvent.mock.calls.filter((c) => c[0] === 'batch_item_progress')
    expect(progress).toHaveLength(2)
    const calls = progress.map((c) => c[1]).sort((a, b) => a.index - b.index)
    expect(calls).toEqual([
      { toolCallId: 'tc-b', index: 0, total: 2, status: 'done', fileId: 'i0' },
      { toolCallId: 'tc-b', index: 1, total: 2, status: 'done', fileId: 'i1' },
    ])
  })

  it('rejects an empty batch and a batch over MAX_BATCH_ITEMS', () => {
    const schema = generateImages.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4, 5].map((n) => imgItem(String(n))) }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4].map((n) => imgItem(String(n))) }).success).toBe(true)
  })

  it('requireApproval delegates to shouldRequireApproval with image_generation and the image model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    const requireApproval = generateImages.requireApproval as unknown as (input: unknown, ctx: unknown) => Promise<boolean>
    expect(await requireApproval({ items: [imgItem('x')] }, ctx)).toBe(true)
    expect(shouldRequireApproval).toHaveBeenCalledWith({ resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview' }, ctx)
  })
})

describe('generate_image charge key', () => {
  it('stays under the ledger index limit for a Gemini thought-signature toolCallId', () => {
    const giant = 'gs.' + 'A'.repeat(7000) + '.0'
    const key = `image:c1:${stableToolCallId(giant)}:0`
    expect(key.length).toBeLessThan(200)
  })
})
