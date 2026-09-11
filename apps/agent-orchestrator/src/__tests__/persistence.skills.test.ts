import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchConversationSkillSettings, saveConversationInvokedSkills } from '../persistence.js'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

const SKILL = { installId: '11111111-1111-4111-8111-111111111111', skillId: '22222222-2222-4222-8222-222222222222', name: 'UGC Ad Production' }

function ok(metadata: unknown) {
  return { ok: true, json: async () => ({ data: { metadata } }) }
}

describe('fetchConversationSkillSettings', () => {
  it('reads the test skill and the invoked list off the conversation', async () => {
    fetchMock.mockResolvedValueOnce(ok({ testSkillInstallId: 'install-t', invokedSkills: [SKILL] }))
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: 'install-t', invokedSkills: [SKILL] })
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/conversations/conv-1')
  })

  it('drops malformed invoked entries', async () => {
    fetchMock.mockResolvedValueOnce(ok({ invokedSkills: [SKILL, { installId: 5 }, null, 'x'] }))
    const result = await fetchConversationSkillSettings('token', 'conv-1')
    expect(result.invokedSkills).toEqual([SKILL])
  })

  it('returns empty settings for a conversation that is not the caller\'s (404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: null, invokedSkills: [] })
  })

  it('returns empty settings on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'))
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: null, invokedSkills: [] })
  })
})

describe('saveConversationInvokedSkills', () => {
  it('PATCHes the full invoked list onto the conversation as the user', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true })
    saveConversationInvokedSkills('token', 'conv-1', [SKILL])
    await Promise.resolve()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v1/conversations/conv-1')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer token')
    expect(JSON.parse(init.body)).toEqual({ invokedSkills: [SKILL] })
  })
})
