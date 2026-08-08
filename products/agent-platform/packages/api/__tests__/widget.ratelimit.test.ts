import { describe, it, expect, beforeEach } from 'vitest'
import { overPublicRateLimit, PUBLIC_LIMITS } from '../lib/public-rate-limit'

/**
 * F-13 — the public widget must be throttled.
 *
 * The bug: widget routes mount on the unauthenticated router and so bypass the
 * middleware chain's rate limiting entirely. Its sibling packs.public.ts added
 * a per-IP throttle specifically because of that; widget.ts had none. Both
 * conversation creation and message send reach a real, metered LLM call, and
 * tenantId/agentId are semi-public (they sit in the embed snippet on any
 * client's site), so anyone could script unlimited billable inference against a
 * tenant's agent.
 *
 * Degrades open on cache failure, matching the existing public-route pattern: a
 * legitimate visitor being refused because Redis blinked is worse than the rate
 * it guards.
 */

function fakeCache() {
  const counts = new Map<string, number>()
  return {
    counts,
    async incr(key: string) {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return next
    },
    async expire() {
      return 1
    },
  }
}

const IP = { 'x-forwarded-for': '203.0.113.9' }

describe('overPublicRateLimit', () => {
  let cache: ReturnType<typeof fakeCache>

  beforeEach(() => {
    cache = fakeCache()
  })

  const call = (n: number, bucket = 'send', limit = 5, headers = IP) =>
    Promise.all(
      Array.from({ length: n }, () =>
        overPublicRateLimit(cache as never, headers, 'tenant-1', bucket, limit),
      ),
    )

  it('allows requests up to the limit', async () => {
    const results = await call(5)
    expect(results.every((r) => r === false)).toBe(true)
  })

  it('refuses the request past the limit', async () => {
    await call(5)
    expect(await overPublicRateLimit(cache as never, IP, 'tenant-1', 'send', 5)).toBe(true)
  })

  it('counts each source IP separately', async () => {
    await call(5)
    const other = { 'x-forwarded-for': '198.51.100.4' }
    expect(await overPublicRateLimit(cache as never, other, 'tenant-1', 'send', 5)).toBe(false)
  })

  it('counts each tenant separately so one embed cannot exhaust another', async () => {
    await call(5)
    expect(await overPublicRateLimit(cache as never, IP, 'tenant-2', 'send', 5)).toBe(false)
  })

  it('keeps read and write buckets independent', async () => {
    await call(5, 'send', 5)
    expect(await overPublicRateLimit(cache as never, IP, 'tenant-1', 'create', 5)).toBe(false)
  })

  it('takes the client IP from the front of x-forwarded-for', async () => {
    // Proxies append; the leftmost entry is the original client.
    const chained = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }
    await overPublicRateLimit(cache as never, chained, 'tenant-1', 'send', 5)
    expect([...cache.counts.keys()].some((k) => k.includes('203.0.113.9'))).toBe(true)
  })

  it('degrades open when the cache is unavailable', async () => {
    const broken = {
      incr: async () => { throw new Error('redis down') },
      expire: async () => { throw new Error('redis down') },
    }
    expect(await overPublicRateLimit(broken as never, IP, 'tenant-1', 'send', 5)).toBe(false)
  })

  it('sets a send limit strictly tighter than the read limit', async () => {
    // Sending costs an LLM call; reading does not.
    expect(PUBLIC_LIMITS.widgetSend).toBeLessThan(PUBLIC_LIMITS.widgetRead)
  })
})
