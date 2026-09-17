/**
 * Explicit Gemini context cache — shared across the direct-API adapter
 * (adapters/gemini.ts) and the Vertex adapter (adapters/vertex.ts).
 *
 * Why this exists: implicit caching on gemini-2.5+ only survives within one
 * conversation and never helps the first turn. Explicit cachedContents.create
 * survives across conversations for as long as the cached (systemInstruction
 * + tools) prefix stays byte-stable — which for Olmo/PC agents is the common
 * case: the DB prompt template is 5-min-TTL cached, tool schemas are
 * 5-min-TTL cached, contract blocks are compile-time constants.
 *
 * Provider adapters own their own "create/reference" API shape (different
 * URLs, different auth) but share this module's map + hash + eviction logic.
 * Two Maps rather than a compound key because gemini names and vertex names
 * are shaped differently ("cachedContents/xxx" vs
 * "projects/.../cachedContents/xxx") and mixing them would be a footgun.
 *
 * Not a general-purpose cache — this only exists to shave the cost/latency
 * of resending a stable prefix. Never let it fail a user turn: every hit
 * path has a fallback to the uncached request. */

import { createHash } from 'node:crypto'

export type ProviderId = 'gemini' | 'vertex'

interface CacheEntry {
  name: string           // full cache handle, e.g. "cachedContents/abc123"
  expiresAtMs: number    // local expiry (< server TTL, so we evict before Google does)
}

// Two disjoint stores. See file-level comment for why not a compound key.
const stores: Record<ProviderId, Map<string, CacheEntry>> = {
  gemini: new Map(),
  vertex: new Map(),
}

// In-flight create dedup, per provider. If two requests miss with the same
// hash at once, only one create call is issued; the other proceeds uncached
// for this turn and picks up the primed cache on its next turn.
const inFlight: Record<ProviderId, Map<string, Promise<void>>> = {
  gemini: new Map(),
  vertex: new Map(),
}

// Local TTL — deliberately shorter than the ttl we ask Google for on
// create. Gives us a margin to evict before the server-side expiry can race
// with an in-flight request that already passed our lookup. Server TTL is
// requested as SERVER_CACHE_TTL_SECONDS below.
const LOCAL_CACHE_TTL_MS = 30 * 60 * 1000     // 30 min in-memory
export const SERVER_CACHE_TTL_SECONDS = 1800  // 30 min asked of Google

// Rough char-to-token proxy. Gemini's min cacheable size is 1024 tokens
// (confirmed by API error: "min_total_token_count=1024"). At ~4 chars/token
// English average, 4096 chars is on the edge — bump the floor to 6000 so we
// don't waste create() calls on prefixes that will just get rejected. A
// prefix that's *just barely* above 1024 tokens saves almost nothing anyway.
const MIN_CACHEABLE_CHARS = 6000

/**
 * Deterministic hash of the cacheable prefix. Changes iff any of the three
 * inputs changes byte-for-byte — which for the orchestrator means iff the
 * DB prompt template, the per-tenant MCP tool set, or the model changes.
 * All three are already slow-moving inputs guarded by their own TTL caches,
 * so this hash stays stable across many conversations.
 *
 * Serialization uses JSON.stringify with sorted object keys so that
 * key-order noise from upstream serializers can't perturb the hash. That's
 * particularly important because Mastra rebuilds the tools array from a
 * Map on every request and Map insertion order is not part of our contract.
 */
export function computePrefixHash(
  model: string,
  systemInstruction: unknown,
  tools: unknown,
): string {
  const canonical = JSON.stringify(
    { model, systemInstruction: systemInstruction ?? null, tools: tools ?? null },
    (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k]
        return sorted
      }
      return value
    },
  )
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Below this many characters in the outgoing prompt, don't even try — the
 * cache create() would just error with "too small" and we've wasted a round
 * trip. See MIN_CACHEABLE_CHARS constant for the token-vs-char reasoning.
 */
export function shouldTryCache(estimatedChars: number): boolean {
  return estimatedChars >= MIN_CACHEABLE_CHARS
}

/**
 * Look up a live cache entry. Returns null (and self-evicts) if the local
 * TTL has passed. Does NOT re-check with the server — expiry there is a
 * separate 403 path that the caller handles by evicting + retrying uncached.
 */
export function getCachedName(providerId: ProviderId, hash: string): string | null {
  const entry = stores[providerId].get(hash)
  if (!entry) return null
  if (entry.expiresAtMs <= Date.now()) {
    stores[providerId].delete(hash)
    return null
  }
  return entry.name
}

/**
 * Store a freshly-created cache handle. `serverTtlSeconds` is what Google
 * actually returned/honored; we clamp local expiry to
 * min(LOCAL_CACHE_TTL_MS, server ttl).
 */
export function putCachedName(
  providerId: ProviderId,
  hash: string,
  name: string,
  serverTtlSeconds: number,
): void {
  const expiresAtMs = Date.now() + Math.min(LOCAL_CACHE_TTL_MS, serverTtlSeconds * 1000)
  stores[providerId].set(hash, { name, expiresAtMs })
}

/**
 * Evict on stale-cache 403 from Google (the "CachedContent not found (or
 * permission denied)" case), or on any create() failure the caller wants to
 * clear from the map.
 */
export function evictCachedName(providerId: ProviderId, hash: string): void {
  stores[providerId].delete(hash)
}

/**
 * Fire-and-forget cache creation, deduplicated by hash. `createFn` is the
 * provider-specific HTTP call that returns the new cache handle. The user
 * turn that triggered this call must not wait on `createFn` — it proceeds
 * with the uncached full prefix, and the next turn with the same hash gets
 * the hit.
 *
 * Errors from createFn are swallowed and logged: cache priming is best-
 * effort. If Google is rejecting our create calls (rate limit, size too
 * small, quota, whatever), the user turn was already served the uncached
 * way and we just skip caching until the create stops failing.
 */
export function primeCache(
  providerId: ProviderId,
  hash: string,
  createFn: () => Promise<{ name: string; ttlSeconds: number }>,
): void {
  if (inFlight[providerId].has(hash)) return
  if (getCachedName(providerId, hash) !== null) return

  const p = (async () => {
    try {
      const { name, ttlSeconds } = await createFn()
      putCachedName(providerId, hash, name, ttlSeconds)
      console.log(`[contextCache:${providerId}] primed hash=${hash.slice(0, 12)} name=${name.slice(-16)} ttl=${ttlSeconds}s`)
    } catch (err) {
      console.warn(`[contextCache:${providerId}] prime failed hash=${hash.slice(0, 12)}: ${(err as Error).message}`)
    } finally {
      inFlight[providerId].delete(hash)
    }
  })()
  inFlight[providerId].set(hash, p)
}

/**
 * Detect the shape of a "your cached content is dead" error so callers can
 * evict + retry uncached rather than surfacing the error to the user.
 * Google's direct API returns HTTP 403 with the specific message below.
 * Vertex returns a similar shape via aiplatform.googleapis.com; the substring
 * match on "CachedContent not found" covers both.
 */
export function isStaleCacheError(status: number, message: string): boolean {
  if (status !== 403 && status !== 404) return false
  return /CachedContent not found/i.test(message) || /cachedContent/i.test(message)
}

/** Exposed for tests + diagnostics. Not called on the hot path. */
export function _debugStats(providerId: ProviderId): { size: number; inFlight: number } {
  return { size: stores[providerId].size, inFlight: inFlight[providerId].size }
}

/** Test-only. Not exported from an index; only importable from within the package. */
export function _clearAll(): void {
  stores.gemini.clear()
  stores.vertex.clear()
  inFlight.gemini.clear()
  inFlight.vertex.clear()
}
