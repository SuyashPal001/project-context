/**
 * Unit tests for the shared context-cache module. Covers the two things a
 * cache-management bug would break silently:
 *   1. hash stability across equivalent inputs (a spurious per-request hash
 *      change reduces the whole feature to no-op — every turn misses).
 *   2. hash sensitivity to genuine input changes (a hash that collides
 *      across different prompts would serve the wrong system prompt).
 * Plus the shouldTryCache threshold, TTL respect, eviction, and dedup.
 *
 * Live-traffic tests (cache-hit rate, TTFT-with-vs-without, cross-
 * conversation win) are separate — see the report for their results.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  computePrefixHash,
  getCachedName,
  putCachedName,
  evictCachedName,
  primeCache,
  shouldTryCache,
  isStaleCacheError,
  _debugStats,
  _clearAll,
  SERVER_CACHE_TTL_SECONDS,
} from './contextCache.js'

beforeEach(() => { _clearAll() })

describe('computePrefixHash', () => {
  it('is stable across identical inputs', () => {
    const h1 = computePrefixHash('gemini-3.6-flash', { parts: [{ text: 'sys' }] }, [{ name: 't' }])
    const h2 = computePrefixHash('gemini-3.6-flash', { parts: [{ text: 'sys' }] }, [{ name: 't' }])
    expect(h1).toBe(h2)
  })

  it('is stable under object-key-order noise', () => {
    // Same content, different key insertion order — mostly matters because
    // Mastra rebuilds tools from a Map every request and Map iteration order
    // is not part of any contract we can rely on.
    const h1 = computePrefixHash('m', { a: 1, b: 2 }, [{ name: 'x', desc: 'y' }])
    const h2 = computePrefixHash('m', { b: 2, a: 1 }, [{ desc: 'y', name: 'x' }])
    expect(h1).toBe(h2)
  })

  it('changes when model changes', () => {
    const h1 = computePrefixHash('gemini-3.6-flash', 'sys', [])
    const h2 = computePrefixHash('gemini-2.5-flash', 'sys', [])
    expect(h1).not.toBe(h2)
  })

  it('changes when systemInstruction changes', () => {
    const h1 = computePrefixHash('m', 'sys A', [])
    const h2 = computePrefixHash('m', 'sys B', [])
    expect(h1).not.toBe(h2)
  })

  it('changes when tools change', () => {
    const h1 = computePrefixHash('m', 'sys', [{ name: 'a' }])
    const h2 = computePrefixHash('m', 'sys', [{ name: 'b' }])
    expect(h1).not.toBe(h2)
  })

  it('treats null and undefined tools identically', () => {
    // Both mean "no tools"; a per-turn null-vs-undefined flicker in the
    // caller must not perturb the hash.
    const h1 = computePrefixHash('m', 'sys', null)
    const h2 = computePrefixHash('m', 'sys', undefined)
    expect(h1).toBe(h2)
  })
})

describe('shouldTryCache', () => {
  it('rejects prefixes under 6000 chars', () => {
    expect(shouldTryCache(1000)).toBe(false)
    expect(shouldTryCache(5999)).toBe(false)
  })
  it('accepts prefixes at/above 6000 chars', () => {
    expect(shouldTryCache(6000)).toBe(true)
    expect(shouldTryCache(50_000)).toBe(true)
  })
})

describe('get/put/evict', () => {
  it('returns null before any put', () => {
    expect(getCachedName('gemini', 'h1')).toBe(null)
  })

  it('roundtrips a name until the local TTL elapses', () => {
    putCachedName('gemini', 'h1', 'cachedContents/abc', 30)
    expect(getCachedName('gemini', 'h1')).toBe('cachedContents/abc')
  })

  it('evicts explicitly', () => {
    putCachedName('gemini', 'h1', 'cachedContents/abc', 30)
    evictCachedName('gemini', 'h1')
    expect(getCachedName('gemini', 'h1')).toBe(null)
  })

  it('self-evicts when the local TTL expires', async () => {
    // 1-second TTL, wait 1.1s, confirm the getter treats it as absent AND
    // physically removes it from the map (so we don't leak on long-running
    // gateway instances with high hash churn).
    putCachedName('gemini', 'h1', 'cachedContents/abc', 1)
    await new Promise(r => setTimeout(r, 1100))
    expect(getCachedName('gemini', 'h1')).toBe(null)
    expect(_debugStats('gemini').size).toBe(0)
  })

  it('keeps gemini and vertex stores disjoint', () => {
    putCachedName('gemini', 'h', 'cachedContents/g', 30)
    putCachedName('vertex', 'h', 'projects/p/locations/l/cachedContents/v', 30)
    expect(getCachedName('gemini', 'h')).toBe('cachedContents/g')
    expect(getCachedName('vertex', 'h')).toBe('projects/p/locations/l/cachedContents/v')
  })
})

describe('primeCache', () => {
  it('populates the map on successful create', async () => {
    let called = 0
    primeCache('gemini', 'h1', async () => {
      called++
      return { name: 'cachedContents/new', ttlSeconds: 60 }
    })
    // primeCache is fire-and-forget — wait for the microtask + promise to settle
    await new Promise(r => setTimeout(r, 20))
    expect(called).toBe(1)
    expect(getCachedName('gemini', 'h1')).toBe('cachedContents/new')
  })

  it('dedups concurrent calls with the same hash', async () => {
    // Two rapid primeCache calls with the same hash must issue exactly one
    // create — otherwise a spike of misses would double-bill on cache creates.
    let called = 0
    const slow = async () => {
      called++
      await new Promise(r => setTimeout(r, 50))
      return { name: 'cachedContents/x', ttlSeconds: 60 }
    }
    primeCache('gemini', 'h1', slow)
    primeCache('gemini', 'h1', slow)
    await new Promise(r => setTimeout(r, 100))
    expect(called).toBe(1)
  })

  it('does nothing when a live entry already exists', async () => {
    putCachedName('gemini', 'h1', 'cachedContents/existing', 30)
    let called = 0
    primeCache('gemini', 'h1', async () => {
      called++
      return { name: 'cachedContents/new', ttlSeconds: 60 }
    })
    await new Promise(r => setTimeout(r, 20))
    expect(called).toBe(0)
    expect(getCachedName('gemini', 'h1')).toBe('cachedContents/existing')
  })

  it('does not put on create failure', async () => {
    primeCache('gemini', 'h1', async () => {
      throw new Error('quota exceeded')
    })
    await new Promise(r => setTimeout(r, 20))
    expect(getCachedName('gemini', 'h1')).toBe(null)
    // in-flight map must also be drained so the next call retries
    expect(_debugStats('gemini').inFlight).toBe(0)
  })
})

describe('isStaleCacheError', () => {
  it('matches the direct-API 403 shape', () => {
    // The exact string Google's direct API returns on a dead cache handle
    // — verified against a live probe against generativelanguage.googleapis.com.
    expect(isStaleCacheError(403, 'CachedContent not found (or permission denied)')).toBe(true)
  })
  it('matches Vertex-shape errors mentioning cachedContent', () => {
    expect(isStaleCacheError(403, 'The specified cachedContent is invalid')).toBe(true)
    expect(isStaleCacheError(404, 'cachedContents/xxx not found')).toBe(true)
  })
  it('does not match unrelated errors', () => {
    expect(isStaleCacheError(400, 'invalid request')).toBe(false)
    expect(isStaleCacheError(500, 'internal error')).toBe(false)
    expect(isStaleCacheError(429, 'rate limited')).toBe(false)
  })
})

describe('constants', () => {
  it('exposes a sensible server TTL', () => {
    // If someone changes this later without thinking, the local TTL becomes
    // > server TTL and we start referencing dead caches on every warm turn.
    // The contextCache module clamps local TTL to server TTL for exactly
    // this reason, but the constant itself should stay well within Google's
    // documented per-project limits (60 min default, up to a few hours).
    expect(SERVER_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(300)
    expect(SERVER_CACHE_TTL_SECONDS).toBeLessThanOrEqual(3600)
  })
})
