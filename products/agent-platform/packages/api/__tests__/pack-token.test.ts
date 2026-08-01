import { describe, it, expect } from 'vitest'
import { mintToken, hashToken } from '../lib/pack-token'

describe('mintToken', () => {
  it('returns a 43-character base64url string', () => {
    const token = mintToken()
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('never returns padding characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(mintToken()).not.toContain('=')
    }
  })

  it('returns a different token on every call', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintToken()))
    expect(tokens.size).toBe(200)
  })
})

describe('hashToken', () => {
  it('returns a 64-character lowercase hex digest', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const token = mintToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('produces different digests for different tokens', () => {
    expect(hashToken(mintToken())).not.toBe(hashToken(mintToken()))
  })

  it('does not leak the token into its own output', () => {
    const token = mintToken()
    expect(hashToken(token)).not.toContain(token)
  })
})
