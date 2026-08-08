import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isInternalServiceKey } from './service-key.js'

/**
 * The orchestrator compared service keys with `===` while the API side used
 * timingSafeEqual everywhere. Low practical risk on a high-entropy secret over
 * a network, but it is one shared helper away from being consistent — and the
 * behaviour that actually matters (empty key never authenticates, unconfigured
 * server never authenticates) is worth pinning either way.
 */

const SECRET = 'z'.repeat(48)

describe('isInternalServiceKey', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_KEY

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = SECRET
  })

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_KEY
    else process.env.INTERNAL_SERVICE_KEY = ORIGINAL
  })

  it('accepts the correct key', () => {
    expect(isInternalServiceKey(SECRET)).toBe(true)
  })

  it('rejects a wrong key of equal length', () => {
    expect(isInternalServiceKey('y'.repeat(48))).toBe(false)
  })

  it('rejects an empty or absent key', () => {
    expect(isInternalServiceKey('')).toBe(false)
    expect(isInternalServiceKey(undefined)).toBe(false)
  })

  it('rejects a length mismatch without throwing', () => {
    expect(isInternalServiceKey('short')).toBe(false)
    expect(isInternalServiceKey('z'.repeat(200))).toBe(false)
  })

  it('never authenticates when the server has no key configured', () => {
    delete process.env.INTERNAL_SERVICE_KEY
    // The `serviceKey !== INTERNAL_SERVICE_KEY` shape would let undefined ===
    // undefined through if the header were also absent.
    expect(isInternalServiceKey('')).toBe(false)
    expect(isInternalServiceKey(undefined)).toBe(false)
    expect(isInternalServiceKey(SECRET)).toBe(false)
  })
})
