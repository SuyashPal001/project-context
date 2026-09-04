import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { validateToken, updateGenerationConfirmRequest } = vi.hoisted(() => ({
  validateToken: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))
vi.mock('../auth.js', () => ({ validateToken }))
vi.mock('../persistence.js', () => ({
  updateClarificationRequest: vi.fn(),
  saveApprovalRequest: vi.fn(),
  updateApprovalRequest: vi.fn(),
  updateGenerationConfirmRequest,
}))

import { sessionsRouter } from './sessions.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../types.js'

const app = new Hono()
app.route('/', sessionsRouter)

beforeEach(() => {
  vi.resetAllMocks()
  pendingGenerationConfirmations.clear()
  sessionActiveGenerationConfirmations.clear()
})

describe('POST /api/chat/generation-confirm', () => {
  it('requires a bearer token', async () => {
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(401)
  })

  it('resolves the pending confirmation and persists approved', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', {
      resolve, timer, tenantId: 't1', messageId: 'm1', conversationId: 'c1', idToken: 'tok',
    })
    sessionActiveGenerationConfirmations.set('s1', new Set(['gc-1']))

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })

    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: true, declineReason: undefined })
    expect(pendingGenerationConfirmations.has('gc-1')).toBe(false)
    expect(updateGenerationConfirmRequest).toHaveBeenCalledWith('tok', 'c1', 'm1', expect.objectContaining({ status: 'approved' }))
    clearTimeout(timer)
  })

  it('404s for an unknown confirmationId', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'nope', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
  })

  it('404s when the caller tenant does not match the pending confirmation tenant', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 'other-tenant' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', { resolve, timer, tenantId: 't1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
    clearTimeout(timer)
  })

  it('resolves declined for decision=declined', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', { resolve, timer, tenantId: 't1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'declined' }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: false, declineReason: undefined })
  })

  it('forwards a decline reason to resolve() and persistence', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', {
      resolve, timer, tenantId: 't1', messageId: 'm1', conversationId: 'c1', idToken: 'tok',
    })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'declined', reason: 'Make it slower' }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({ confirmed: false, declineReason: 'Make it slower' })
    expect(updateGenerationConfirmRequest).toHaveBeenCalledWith('tok', 'c1', 'm1', expect.objectContaining({ status: 'declined', declineReason: 'Make it slower' }))
  })

  it('rejects a reason over 500 characters', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', { resolve, timer, tenantId: 't1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'declined', reason: 'x'.repeat(501) }),
    })
    expect(res.status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
    clearTimeout(timer)
  })
})
