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

import { generateNarration, inputSchema } from './generateNarration.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 30_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateNarration tool', () => {
  it('charges credits BEFORE calling the gateway, then uploads and returns fileId + durationSeconds', async () => {
    const callOrder: string[] = []
    ;(spendCredits as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('charge') })
    global.fetch = vi.fn(async () => {
      callOrder.push('gateway')
      return new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav', durationSeconds: 12.5 }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'narration.wav', type: 'audio/wav', size: 3 })

    const result = await generateNarration.execute!({ script: 'Hello world', voiceId: 'v1' } as never, baseCtx())

    expect(callOrder).toEqual(['charge', 'gateway'])
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -30_000n, kind: 'debit', jobType: 'narration_generation' }))
    expect(result).toMatchObject({ fileId: 'f1', name: 'narration.wav', fileType: 'audio/wav', size: 3, durationSeconds: 12.5 })
  })

  it('refuses a script over 500 characters via the schema before any charge', async () => {
    const longScript = 'a'.repeat(501)
    // Zod validation happens at the Mastra tool-call boundary, not inside
    // execute() — this test calls execute() directly (bypassing that
    // boundary, same as every other tool test in this codebase), so assert
    // the schema itself rejects the input rather than expecting execute()
    // to re-validate. Uses the raw exported `inputSchema` (not
    // `generateNarration.inputSchema`, which Mastra's createTool wraps in a
    // StandardSchemaWithJSON type with no .safeParse at the type level).
    const parseResult = inputSchema.safeParse({ script: longScript, voiceId: 'v1' })
    expect(parseResult.success).toBe(false)
  })

  it('passes the gateway refusal reason through and refunds the charge', async () => {
    ;(spendCredits as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'CUSTOM_REASON' }), { status: 200 })) as unknown as typeof fetch
    ;(getPool as ReturnType<typeof vi.fn>).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-30000', expires_at: null }] }) })

    const result = await generateNarration.execute!({ script: 'Hello', voiceId: 'v1' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'CUSTOM_REASON' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'narration_generation' }))
  })

  it('does not attempt a refund when the charge itself fails with insufficient credits', async () => {
    class InsufficientCreditsError extends Error { name = 'InsufficientCreditsError' }
    ;(spendCredits as ReturnType<typeof vi.fn>).mockRejectedValue(new InsufficientCreditsError('insufficient'))
    global.fetch = vi.fn() as unknown as typeof fetch

    const result = await generateNarration.execute!({ script: 'Hello', voiceId: 'v1' } as never, baseCtx())

    expect(result).toMatchObject({ insufficientCredits: true })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refunds the charge when the gateway call fails after a successful charge', async () => {
    ;(spendCredits as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    global.fetch = vi.fn(async () => { throw new Error('network error') }) as unknown as typeof fetch
    ;(getPool as ReturnType<typeof vi.fn>).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-30000', expires_at: null }] }) })

    const result = await generateNarration.execute!({ script: 'Hello', voiceId: 'v1' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'GENERATION_FAILED' })
    // refund path re-calls spendCredits with kind: 'refund'
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'narration_generation' }))
  })

  it('does not default agentId to empty string when absent from requestContext', async () => {
    ;(spendCredits as ReturnType<typeof vi.fn>).mockImplementation(async (args) => {
      expect(args.actorId).toBeUndefined()
    })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav', durationSeconds: 5 }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'n.wav', type: 'audio/wav', size: 3 })

    await generateNarration.execute!({ script: 'Hi', voiceId: 'v1' } as never, ctx({ tenantId: 't1', conversationId: 'c1', idToken: 'tok' }))
    expect(spendCredits).toHaveBeenCalled()
  })
})
