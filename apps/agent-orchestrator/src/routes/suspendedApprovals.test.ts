import { describe, it, expect, vi } from 'vitest'

const { executeSql } = vi.hoisted(() => ({ executeSql: vi.fn() }))
vi.mock('../mastra/tools/folderScope.js', () => ({ executeSql }))

import { parseResumeApproval, findSuspendedApproval, latestDelegationPrompt } from './suspendedApprovals.js'

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
    expect(found).toEqual({ status: 'found', approval: { runId: 'r2', toolCallId: 'c1', toolName: 'generate_video', args: { prompt: 'p' } } })
  })
  it('tells a run that is gone from a lookup that failed', async () => {
    const agent = { listSuspendedRuns: vi.fn().mockResolvedValue({ runs: [run('r1', [{ toolCallId: 'c1', requiresApproval: false }])] }) }
    expect(await findSuspendedApproval(agent, 'conv1', 'tenant1', 'c1')).toEqual({ status: 'missing' })
    expect(await findSuspendedApproval({ listSuspendedRuns: vi.fn().mockRejectedValue(new Error('db')) }, 'conv1', 'tenant1', 'c1')).toEqual({ status: 'error' })
  })
})

describe('latestDelegationPrompt', () => {
  it("reads the text of Olmo's last delegate prompt in this chat", async () => {
    executeSql.mockResolvedValueOnce([{ content: { format: 2, parts: [{ type: 'text', text: 'flow: animation character ad' }] } }])
    expect(await latestDelegationPrompt('conv1', 'tenant1')).toBe('flow: animation character ad')
    executeSql.mockResolvedValueOnce({ rows: [{ content: JSON.stringify({ parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) }] })
    expect(await latestDelegationPrompt('conv1', 'tenant1')).toBe('a\nb')
  })
  it('is null with nothing to read or a failed lookup', async () => {
    executeSql.mockResolvedValueOnce([])
    expect(await latestDelegationPrompt('conv1', 'tenant1')).toBeNull()
    executeSql.mockRejectedValueOnce(new Error('db'))
    expect(await latestDelegationPrompt('conv1', 'tenant1')).toBeNull()
    expect(await latestDelegationPrompt('', 'tenant1')).toBeNull()
  })
})
