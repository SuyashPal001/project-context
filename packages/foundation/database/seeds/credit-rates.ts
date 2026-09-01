import { and, eq } from 'drizzle-orm';
import { creditRates } from '../schema/index';
import type { db as DB } from './index';

// 1 credit = 1 US cent. Values derived from apps/agent-orchestrator/src/mastra/cost.ts.
// gemini-2.5-flash $0.15/1M input -> 15 credits -> 15_000_000 micro.
const RATES = [
  { resourceType: 'llm_tokens', subject: 'gemini-2.5-flash',
    pricingSchema: { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } } },
  { resourceType: 'llm_tokens', subject: 'gemini-2.5-flash-lite',
    pricingSchema: { per_million_tokens_micro: { input: 7_500_000, output: 30_000_000 } } },
  { resourceType: 'llm_tokens', subject: 'gemini-2.5-pro',
    pricingSchema: { per_million_tokens_micro: { input: 125_000_000, output: 500_000_000 } } },
  { resourceType: 'llm_tokens', subject: 'ollama',            // self-hosted, free
    pricingSchema: { per_million_tokens_micro: { input: 0, output: 0 } } },
  { resourceType: 'llm_tokens', subject: '*',                 // matches today's flash fallback
    pricingSchema: { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } } },
  // Placeholder price — ops should set the real per-call cost before this ships broadly.
  { resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
    pricingSchema: { per_call_micro: 50_000 } },
  // Metering ships before pricing: these are deliberately free on day one so ops can
  // price them later without a deploy (spec section 3).
  { resourceType: 'message',   subject: '*', pricingSchema: { per_message_micro: 0 } },
  { resourceType: 'tool_call', subject: '*', pricingSchema: { per_call_micro: 0 } },
  { resourceType: 'skill_run', subject: '*', pricingSchema: { per_run_micro: 0 } },
] as const;

export async function seedCreditRates(db: typeof DB) {
  console.log('seeding credit rates');
  for (const r of RATES) {
    const existing = await db.select().from(creditRates).where(and(
      eq(creditRates.resourceType, r.resourceType),
      eq(creditRates.subject, r.subject),
      eq(creditRates.version, 1),
    )).limit(1);
    if (existing.length > 0) continue;      // never overwrite: rate edits are new versions
    await db.insert(creditRates).values({ ...r, version: 1, isActive: true });
  }
}
