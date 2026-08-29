import { db, tokenCosts } from '@serverless-saas/database'
import { resolveRate, costMicro, type PricingSchema } from '@serverless-saas/credits'

// Gemini pricing per 1M tokens (as of mid-2025).
// FALLBACK ONLY — used when `credit_rates` has not been seeded in this
// environment (e.g. a fresh local DB before migrations/seeds run), or when
// loadRates() failed to reach the DB at startup. The values mirror the rows
// seeded in packages/foundation/database/seeds/credit-rates.ts — do not
// change one without the other.
// Self-hosted models (ollama/*) cost $0.
const FALLBACK_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5.00 },
}

// 1 credit = 1 US cent. Everything inside @serverless-saas/credits stays
// bigint micro-credits; this is the one place a float legitimately appears,
// converting for the existing token_costs (USD) column.
const microToUsd = (micro: bigint): number => Number(micro) / 1_000_000 / 100

// In-memory cache of active `credit_rates` rows for resourceType
// 'llm_tokens', keyed by subject: the bare model key (e.g. 'gemini-2.5-flash'),
// 'ollama' for self-hosted models, or '*' for the catch-all row. Populated
// once at startup by loadRates(). calculateCostUsd stays synchronous and
// reads whatever is cached; a subject with no cache entry (loadRates() never
// ran, failed, or the row isn't seeded) falls through to FALLBACK_PRICING.
const rateCache = new Map<string, PricingSchema>()

const RATE_SUBJECTS = [...Object.keys(FALLBACK_PRICING), 'ollama', '*']

/** Loads active credit_rates rows into the in-memory cache. Call once at startup. */
export async function loadRates(): Promise<void> {
  for (const subject of RATE_SUBJECTS) {
    const rate = await resolveRate('llm_tokens', subject)
    if (rate) rateCache.set(subject, rate.schema)
  }
}

function keyFor(model: string): string {
  return model.includes('/') ? model.split('/').pop()! : model
}

export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (model.startsWith('ollama/')) {
    const ollamaRate = rateCache.get('ollama')
    if (ollamaRate) return microToUsd(costMicro(ollamaRate, { inputTokens, outputTokens }))
    return 0
  }
  const key = keyFor(model)
  const rate = rateCache.get(key) ?? rateCache.get('*')
  if (rate) return microToUsd(costMicro(rate, { inputTokens, outputTokens }))
  const p = FALLBACK_PRICING[key] ?? FALLBACK_PRICING['gemini-2.5-flash']
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export interface CostRecord {
  tenantId: string
  agentId?: string
  workflowId?: string
  runId?: string
  model: string
  inputTokens: number
  outputTokens: number
}

export function persistCost(record: CostRecord): void {
  const costUsd = calculateCostUsd(record.model, record.inputTokens, record.outputTokens)
  db.insert(tokenCosts).values({
    tenantId: record.tenantId,
    agentId: record.agentId,
    workflowId: record.workflowId,
    runId: record.runId,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: String(costUsd),
  }).catch(err => {
    console.error('[cost] persistCost failed', err)
  })
}
