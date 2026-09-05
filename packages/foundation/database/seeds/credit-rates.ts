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
  // Nano Banana Pro costs $0.134/image at Vertex AI list price; priced at cost + ~27% margin.
  // Replaces the old 50_000 placeholder, which was billing below cost on every image.
  { resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
    pricingSchema: { per_call_micro: 170_000 } },
  // Lyria-002 costs $0.04-0.08/track at Vertex AI list price; priced above the top of that
  // range for margin. Replaces the old 20_000 placeholder, which was billing below cost.
  { resourceType: 'music_generation', subject: 'lyria-002',
    pricingSchema: { per_call_micro: 60_000 } },
  // Veo-family models bill per SECOND ($0.03-$0.75/sec depending on tier/audio) but this tool
  // charges a flat per-call rate because generateVideo.ts never receives clip duration back
  // from the inference gateway to meter against. 400_000 assumes a worst-case ~8s clip at the
  // cheapest (lite, no-audio) tier plus margin — it is NOT true per-second metering, and a
  // longer or audio-bearing clip can still cost more than this charges. Fixing that requires
  // the gateway to report duration; flag before enabling longer or audio-bearing video output.
  { resourceType: 'video_generation', subject: 'gemini-omni-1.1-flash',
    pricingSchema: { per_call_micro: 400_000 } },
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
