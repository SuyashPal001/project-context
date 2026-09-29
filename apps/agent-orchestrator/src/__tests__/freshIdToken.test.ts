import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../auth.js', () => ({
  validateToken: vi.fn(async (token: string) => {
    if (token === 'bad') throw new Error('invalid signature')
    return { sub: token.startsWith('other') ? 'user-2' : 'user-1' }
  }),
}))

import { acceptFreshIdToken, latestIdToken, clearFreshIdToken } from '../freshIdToken.js'

describe('fresh id token hand-over', () => {
  beforeEach(() => clearFreshIdToken('conv-1'))

  it('uses a verified token from the same user for the rest of the turn', async () => {
    expect(latestIdToken('conv-1', 'old')).toBe('old')
    expect(await acceptFreshIdToken('conv-1', 'fresh', 'user-1')).toBe('fresh')
    expect(latestIdToken('conv-1', 'old')).toBe('fresh')
  })

  it('ignores a token that fails verification or belongs to another user', async () => {
    expect(await acceptFreshIdToken('conv-1', 'bad', 'user-1')).toBeNull()
    expect(await acceptFreshIdToken('conv-1', 'other-token', 'user-1')).toBeNull()
    expect(latestIdToken('conv-1', 'old')).toBe('old')
  })

  it('ignores a missing header or conversation, and a new turn clears the hand-over', async () => {
    expect(await acceptFreshIdToken(undefined, 'fresh', 'user-1')).toBeNull()
    expect(await acceptFreshIdToken('conv-1', undefined, 'user-1')).toBeNull()
    await acceptFreshIdToken('conv-1', 'fresh', 'user-1')
    clearFreshIdToken('conv-1')
    expect(latestIdToken('conv-1', 'new-turn')).toBe('new-turn')
  })
})
