import { describe, it, expect, vi } from 'vitest'
import { parseResumeApproval, findSuspendedApproval, declineStaleApprovals } from './suspendedApprovals.js'

const run = (runId: string, toolCalls: Array<Record<string, unknown>>) => ({ runId, status: 'suspended', toolCalls })

describe('parseResumeApproval', () => {
  it('reads an approve or a decline with its note', () => {
    expect(parseResumeApproval({ confirmationId: ' c1 ', decision: 'approved', cardMessageId: 'm1' }))
      .toEqual({ toolCallId: 'c1', decision: 'approved', cardMessageId: 'm1' })
    expect(parseResumeApproval({ confirmationId: 'c1', decision: 'declined', reason: ' too dear ' }))
      .toEqual({ toolCallId: 'c1', decision: 'declined', declineReason: 'too dear' })
  })
  it('rejects anything else', () => {
    expect(parseResumeApproval(undefined)).toBeNull()
    expect(parseResumeApproval({ confirmationId: '', decision: 'approved' })).toBeNull()
    expect(parseResumeApproval({ confirmationId: 'c1', decision: 'maybe' })).toBeNull()
    expect(parseResumeApproval({ confirmationId: 'c1', decision: 'declined', reason: 'x'.repeat(501) })).toBeNull()
  })
})

describe('findSuspendedApproval', () => {
  it('finds the run waiting on this card, scoped to the chat and tenant', async () => {
    const listSuspendedRuns = vi.fn().mockResolvedValue({ runs: [
      run('r1', [{ toolCallId: 'other', requiresApproval: true }]),
      run('r2', [{ toolCallId: 'c1', toolName: 'generate_video', args: { prompt: 'p' }, requiresApproval: true }]),
    ] })
    const found = await findSuspendedApproval({ listSuspendedRuns }, 'conv1', 'tenant1', 'c1')
    expect(listSuspendedRuns).toHaveBeenCalledWith({ threadId: 'conv1', resourceId: 'tenant1' })
    expect(found).toEqual({ runId: 'r2', toolCallId: 'c1', toolName: 'generate_video', args: { prompt: 'p' } })
  })
  it('is null when the run is gone or the call is not an approval', async () => {
    const agent = { listSuspendedRuns: vi.fn().mockResolvedValue({ runs: [run('r1', [{ toolCallId: 'c1', requiresApproval: false }])] }) }
    expect(await findSuspendedApproval(agent, 'conv1', 'tenant1', 'c1')).toBeNull()
    expect(await findSuspendedApproval({ listSuspendedRuns: vi.fn().mockRejectedValue(new Error('db')) }, 'conv1', 'tenant1', 'c1')).toBeNull()
  })
})

describe('declineStaleApprovals', () => {
  it('declines every approval left waiting on this chat, except one a live page still holds', async () => {
    const consumeStream = vi.fn().mockResolvedValue(undefined)
    const agent = {
      listSuspendedRuns: vi.fn().mockResolvedValue({ runs: [
        run('r1', [{ toolCallId: 'stale', requiresApproval: true }]),
        run('r2', [{ toolCallId: 'live', requiresApproval: true }]),
        run('r3', [{ toolCallId: 'wf', requiresApproval: false }]),
      ] }),
      declineToolCall: vi.fn().mockResolvedValue({ consumeStream }),
    }
    const n = await declineStaleApprovals(agent, 'conv1', 'tenant1', (id) => id === 'live', 'moved on')
    expect(n).toBe(1)
    expect(agent.declineToolCall).toHaveBeenCalledTimes(1)
    expect(agent.declineToolCall).toHaveBeenCalledWith({ runId: 'r1', toolCallId: 'stale', reason: 'moved on' })
    expect(consumeStream).toHaveBeenCalled()
  })
  it('never throws: a failed lookup or decline leaves the new message to go ahead', async () => {
    expect(await declineStaleApprovals({ listSuspendedRuns: vi.fn().mockRejectedValue(new Error('db')), declineToolCall: vi.fn() }, 'c', 't', () => false, 'r')).toBe(0)
    const agent = {
      listSuspendedRuns: vi.fn().mockResolvedValue({ runs: [run('r1', [{ toolCallId: 'x', requiresApproval: true }])] }),
      declineToolCall: vi.fn().mockRejectedValue(new Error('snapshot not found')),
    }
    expect(await declineStaleApprovals(agent, 'c', 't', () => false, 'r')).toBe(0)
  })
})
