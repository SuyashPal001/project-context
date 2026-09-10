import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { validateToken } = vi.hoisted(() => ({
  validateToken: vi.fn(),
}))
vi.mock('../auth.js', () => ({ validateToken }))
vi.mock('../persistence.js', () => ({
  updateClarificationRequest: vi.fn(),
  saveApprovalRequest: vi.fn(),
  updateApprovalRequest: vi.fn(),
  updateUploadRequest: vi.fn(),
}))

import { sessionsRouter } from './sessions.js'
import { pendingClarifications, pendingToolApprovals, sessionActiveToolApprovals } from '../types.js'

const app = new Hono()
app.route('/', sessionsRouter)

beforeEach(() => {
  vi.resetAllMocks()
  pendingToolApprovals.clear()
  sessionActiveToolApprovals.clear()
})

describe('POST /api/chat/generation-confirm', () => {
  it('requires a bearer token', async () => {
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(401)
  })

  it('resolves the pending entry and returns ok on approve', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    pendingToolApprovals.set('tc-1', { resolve, tenantId: 't1', runId: 'r1', toolCallId: 'tc-1' })
    sessionActiveToolApprovals.set('s1', new Set(['tc-1']))

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'approved' }),
    })

    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: true, declineReason: undefined })
    expect(pendingToolApprovals.has('tc-1')).toBe(false)
    expect(sessionActiveToolApprovals.has('s1')).toBe(false)
  })

  it('404s for an unknown confirmationId', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'nonexistent', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
  })

  it('404s when the caller tenant does not match the pending entry tenant', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 'other-tenant' })
    const resolve = vi.fn()
    pendingToolApprovals.set('tc-1', { resolve, tenantId: 't1', runId: 'r1', toolCallId: 'tc-1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves declined for decision=declined', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    pendingToolApprovals.set('tc-1', { resolve, tenantId: 't1', runId: 'r1', toolCallId: 'tc-1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'declined' }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: false, declineReason: undefined })
  })

  it('forwards a decline reason to resolve()', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    pendingToolApprovals.set('tc-1', { resolve, tenantId: 't1', runId: 'r1', toolCallId: 'tc-1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'declined', reason: 'Make it slower' }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: false, declineReason: 'Make it slower' })
  })

  it('rejects a reason over 500 characters', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    pendingToolApprovals.set('tc-1', { resolve, tenantId: 't1', runId: 'r1', toolCallId: 'tc-1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'tc-1', decision: 'declined', reason: 'x'.repeat(501) }),
    })
    expect(res.status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })
})


describe('POST /api/chat/clarification attachments', () => {
  it('passes uploaded files to the agent and persists them', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingClarifications.set('clar-files', {
      resolve, timer, tenantId: 't1', userId: 'u1', expectedCount: 1, collected: [],
      messageId: 'm1', conversationId: 'c1', idToken: 'tok',
    })
    const files = [{ fileId: 'file-1', name: 'product.png', type: 'image/png' }]
    const res = await app.request('/api/chat/clarification', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ clarificationId: 'clar-files', questionIndex: 0, files }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith([expect.objectContaining({ questionIndex: 0, files })])
    const { updateClarificationRequest } = await import('../persistence.js')
    expect(updateClarificationRequest).toHaveBeenCalledWith('tok', 'c1', 'm1', expect.objectContaining({
      answers: { 0: expect.objectContaining({ files }) },
    }))
  })

  it('rejects malformed file references without completing the question', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingClarifications.set('clar-invalid', { resolve, timer, tenantId: 't1', userId: 'u1', expectedCount: 1, collected: [] })
    try {
      const res = await app.request('/api/chat/clarification', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ clarificationId: 'clar-invalid', questionIndex: 0, files: [{ name: 'missing-id.png' }] }),
      })
      expect(res.status).toBe(400)
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timer)
      pendingClarifications.delete('clar-invalid')
    }
  })
})
