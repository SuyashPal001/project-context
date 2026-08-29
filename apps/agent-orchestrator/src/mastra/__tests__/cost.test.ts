import { describe, it, expect, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@serverless-saas/database'
import { calculateCostUsd, loadRates } from '../cost.js'

describe('calculateCostUsd', () => {
  it('matches the pre-migration prices for flash', () => {
    // 1M input + 1M output at $0.15 / $0.60
    expect(calculateCostUsd('gemini-2.5-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6)
  })

  it('is free for self-hosted models', () => {
    expect(calculateCostUsd('ollama/llama3', 1_000_000, 1_000_000)).toBe(0)
  })

  it('falls back to flash pricing for an unknown model', () => {
    expect(calculateCostUsd('some-new-model', 1_000_000, 0)).toBeCloseTo(0.15, 6)
  })
})

// These prove calculateCostUsd is actually reading credit_rates through the
// cache populated by loadRates() - not just always landing on
// FALLBACK_PRICING, which happens to hold the same numbers by construction
// (Task 5 seeded credit_rates FROM this file's old hardcoded map). A
// distinct, temporarily-inserted rate is the only way to tell the two paths
// apart.
const TEST_DB = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DB)('calculateCostUsd via credit_rates cache', () => {
  afterEach(async () => {
    // Belt-and-suspenders cleanup in case the `it` block's own finally didn't
    // run - always leave exactly the seeded version-1 row active.
    await db.execute(sql`
      delete from credit_rates where resource_type = 'llm_tokens' and subject = 'gemini-2.5-flash' and version = 999
    `)
    await db.execute(sql`
      update credit_rates set is_active = true
      where resource_type = 'llm_tokens' and subject = 'gemini-2.5-flash' and version = 1
    `)
    await loadRates()
  })

  it('prices from an active credit_rates row that differs from the fallback map', async () => {
    // Only one row may be active per (resource_type, subject) at a time -
    // deactivate the seeded version so the overridden version is unambiguous.
    await db.execute(sql`
      update credit_rates set is_active = false
      where resource_type = 'llm_tokens' and subject = 'gemini-2.5-flash' and version = 1
    `)
    // Distinct from FALLBACK_PRICING's flash entry (15,000,000 / 60,000,000
    // micro per million tokens) so a pass can only mean the cache was
    // actually consulted.
    await db.execute(sql`
      insert into credit_rates (resource_type, subject, version, pricing_schema, is_active)
      values ('llm_tokens', 'gemini-2.5-flash', 999,
              '{"per_million_tokens_micro": {"input": 1000000, "output": 2000000}}'::jsonb, true)
    `)

    await loadRates()
    // 1M input + 1M output at the overridden rate: (1,000,000 + 2,000,000) micro-credits = 3 credits = $0.03
    expect(calculateCostUsd('gemini-2.5-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.03, 6)
  })
})
