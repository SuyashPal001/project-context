import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '@serverless-saas/ai/src/utils/encryption'

/**
 * F-07 — platform LLM provider API keys must be encrypted at rest.
 *
 * The bug: ops.providers.ts stored `Buffer.from(apiKey).toString('base64')` into
 * a column named `apiKeyEncrypted`. Base64 is reversible encoding, so every
 * provider credential (OpenAI, Anthropic, Mistral, OpenRouter, Kimi, Vertex) was
 * recoverable from any backup or read replica with a single `base64 -d` — while
 * the logger masked the field as a secret and a purpose-built AES-256-GCM helper
 * for this exact column sat unused.
 *
 * These tests cover the helper that was dead code, and pin the property that
 * actually failed: the stored form must not be trivially decodable.
 */

const PLAINTEXT = 'sk-proj-abc123SUPERSECRETkey456'

describe('provider secret encryption', () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY ??= 'test-master-key-for-unit-tests-only'
  })

  it('round-trips a secret', () => {
    expect(decryptSecret(encryptSecret(PLAINTEXT))).toBe(PLAINTEXT)
  })

  it('does not leave the plaintext recoverable by base64 decoding', () => {
    // The precise regression: base64 "encryption" fails this.
    const stored = encryptSecret(PLAINTEXT)
    let decoded = ''
    try {
      decoded = Buffer.from(stored, 'base64').toString('utf8')
    } catch {
      /* not valid base64 at all — also fine */
    }
    expect(decoded).not.toContain(PLAINTEXT)
    expect(stored).not.toContain(PLAINTEXT)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret(PLAINTEXT)).not.toBe(encryptSecret(PLAINTEXT))
  })

  it('isolates secrets by salt so one tenant cannot read another', () => {
    const forTenantA = encryptSecret(PLAINTEXT, 'tenant-a')
    expect(() => decryptSecret(forTenantA, 'tenant-b')).toThrow()
  })

  it('round-trips values containing non-ascii and newlines', () => {
    const gnarly = 'line1\nline2\t✓ émoji 🚀 "quoted"'
    expect(decryptSecret(encryptSecret(gnarly))).toBe(gnarly)
  })
})
