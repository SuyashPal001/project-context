import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { isUnlimited, resolveRate, saveGenerationConfirmRequest, updateGenerationConfirmRequest } = vi.hoisted(() => ({
  isUnlimited: vi.fn(),
  resolveRate: vi.fn(),
  saveGenerationConfirmRequest: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({ isUnlimited, resolveRate }))
vi.mock('../../persistence.js', () => ({ saveGenerationConfirmRequest, updateGenerationConfirmRequest }))

import { confirmGenerationOrDecline } from './confirmGeneration.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../../types.js'

function ctx(values: Record<string, unknown>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const sendEvent = vi.fn()
const baseCtx = () => ctx({
  tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent,
})

beforeEach(() => {
  vi.resetAllMocks()
  pendingGenerationConfirmations.clear()
  sessionActiveGenerationConfirmations.clear()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('confirmGenerationOrDecline', () => {
  it('skips the gate for an unlimited tenant — no sendEvent', async () => {
    isUnlimited.mockResolvedValue(true)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when allowMode is auto — no sendEvent', async () => {
    const result = await confirmGenerationOrDecline(
      ctx({ tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent, allowMode: 'auto' }),
      'image_generation', 'model-x', 'Generate image',
    )
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when no active rate resolves — no sendEvent', async () => {
    resolveRate.mockResolvedValue(null)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when there is no active session — no sendEvent', async () => {
    const noSessionCtx = ctx({ tenantId: 't1' }) // missing sendEvent/sessionId/userId
    const result = await confirmGenerationOrDecline(noSessionCtx, 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
  })

  it('sends the event, persists, and resolves confirmed when the pending map is resolved with true', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({
      resourceType: 'image_generation', subject: 'model-x', label: 'Generate image',
    }))
    expect(saveGenerationConfirmRequest).toHaveBeenCalledTimes(1)

    const [[confirmationId]] = sessionActiveGenerationConfirmations.get('s1')
      ? [Array.from(sessionActiveGenerationConfirmations.get('s1')!)]
      : [[]]
    const pending = pendingGenerationConfirmations.get(confirmationId)
    pending!.resolve({ confirmed: true })

    const result = await promise
    expect(result).toEqual({ confirmed: true })
  })

  // The card is the control the spec's credential defence rests on, so what is
  // being approved has to reach the card, not just its title.
  it('carries the preview through to both the SSE event and the persisted row', async () => {
    const promise = confirmGenerationOrDecline(
      baseCtx(), 'skill_creation', 'create', 'Create skill "Bid Writer"',
      { alwaysAsk: true, preview: '---\nname: bid-writer\n---\n\nOpen with the client name.' },
    )
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent.mock.calls[0][1]).toMatchObject({ preview: expect.stringContaining('Open with the client name.') })
    expect(saveGenerationConfirmRequest.mock.calls[0][3]).toMatchObject({ preview: expect.stringContaining('bid-writer') })

    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false })
    await promise
  })

  it('omits preview entirely when the caller has nothing to show', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent.mock.calls[0][1]).not.toHaveProperty('preview')

    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false })
    await promise
  })

  it('resolves declined when the pending map is resolved with confirmed: false', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false })

    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('forwards declineReason through to the tool result', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false, declineReason: 'Make it slower' })

    const result = await promise
    expect(result).toEqual({ confirmed: false, declineReason: 'Make it slower' })
  })

  it('auto-declines after the 5-minute timeout', async () => {
    vi.useFakeTimers()
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.advanceTimersByTimeAsync(300_000)
    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('declines a second concurrent request for the same session without sending a second event', async () => {
    const first = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))

    const second = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(second).toEqual({ confirmed: false, reason: 'CONFIRM_BUSY' })
    expect(sendEvent).toHaveBeenCalledTimes(1) // still just the first

    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: true })
    await first
  })

  it('asks an unlimited tenant when alwaysAsk is set', async () => {
    isUnlimited.mockResolvedValue(true)
    const promise = confirmGenerationOrDecline(baseCtx(), 'skill_creation', 'create', 'Create skill', { alwaysAsk: true })
    // The card was sent rather than auto-approved.
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ resourceType: 'skill_creation' })))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: true })
    await expect(promise).resolves.toMatchObject({ confirmed: true })
  })

  it('asks when no credit rate matches and alwaysAsk is set', async () => {
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue(null)
    const promise = confirmGenerationOrDecline(baseCtx(), 'skill_creation', 'create', 'Create skill', { alwaysAsk: true })
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalled())
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false })
    await expect(promise).resolves.toMatchObject({ confirmed: false })
  })

  // Auto-allow is an explicit user setting, and alwaysAsk does not override it.
  it('still honours allowMode auto when alwaysAsk is set', async () => {
    const promise = confirmGenerationOrDecline(
      ctx({ tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent, allowMode: 'auto' }),
      'skill_creation', 'create', 'Create skill', { alwaysAsk: true })
    await expect(promise).resolves.toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  // Without the flag, nothing about the existing spend-gate behaviour moves.
  it('still auto-approves an unlimited tenant without alwaysAsk', async () => {
    isUnlimited.mockResolvedValue(true)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'x', 'y')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })
})
