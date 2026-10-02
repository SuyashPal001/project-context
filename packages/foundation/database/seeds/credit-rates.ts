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
  // Nano Banana Pro costs $0.134/image at Vertex AI list price; priced at cost + ~27% margin:
  // 17 credits = $0.17. (Was 170_000 — 0.17 credits, $0.0017 — the dollar figure written as
  // if 1 credit were $1, which billed every image at about 1/80 of what it costs.)
  { resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
    pricingSchema: { per_call_micro: 17_000_000 } },
  // Lyria-002 costs $0.04-0.08/track at Vertex AI list price: 6 credits = $0.06.
  // (Was 60_000 — the same dollars-for-cents slip as the image row, 1/100 of cost.)
  { resourceType: 'music_generation', subject: 'lyria-002',
    pricingSchema: { per_call_micro: 6_000_000 } },
  // Veo-family models bill per SECOND ($0.03-$0.75/sec depending on tier/audio) but this tool
  // charges a flat per-call rate because generateVideo.ts never receives clip duration back
  // from the inference gateway to meter against. 400_000 assumes a worst-case ~8s clip at the
  // cheapest (lite, no-audio) tier plus margin — it is NOT true per-second metering, and a
  // longer or audio-bearing clip can still cost more than this charges. Fixing that requires
  // the gateway to report duration; flag before enabling longer or audio-bearing video output.
  // 40 credits = $0.40 per clip. (Was 400_000 — 0.4 credits — the dollars-for-cents slip.)
  // Still a flat guess, not checked against Omni's real per-second price: see the warning
  // on the bare-subject row below before trusting it for 10s clips with audio.
  { resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash',
    pricingSchema: { per_call_micro: 40_000_000 } },
  // Superseded by the 'google/gemini-omni-1.1-flash' row above, per
  // docs/media-generation/README.md's namespaced-model-id convention.
  // generateVideo.ts now looks up rates under the namespaced subject.
  // Do not remove this row until confirming no other code (reporting queries,
  // dashboards) still references the bare subject string.
  //
  // PRICING NOT RE-EVALUATED HERE: this comment block already warned the
  // original per_call_micro assumed "cheapest, no-audio, ~8s" and said to
  // flag before enabling longer or audio-bearing output. This plan enables
  // up to 10s and dialogue (audio is always on for Omni, unconditionally —
  // see Task 7/8's gateway work). The namespaced row above copies the same
  // price verbatim — re-pricing is a deliberate follow-up, not silently
  // skipped; do not treat this row's number as validated for the new
  // capability range.
  { resourceType: 'video_generation', subject: 'gemini-omni-1.1-flash',
    pricingSchema: { per_call_micro: 40_000_000 } },
  // Cartesia sonic-3.5: ~$0.02 per 30s ad script (per spec's cost research,
  // $40-42/1M characters, ~500 chars max script = ~$0.021). Priced with
  // margin at a flat per-call rate rather than per-character, matching this
  // codebase's existing flat-per-call convention for narration-sized clips.
  // 3 credits = $0.03. (Was 30_000 — the dollars-for-cents slip.)
  { resourceType: 'narration_generation', subject: 'sonic-3.5',
    pricingSchema: { per_call_micro: 3_000_000 } },
  // fal.ai LatentSync: flat $0.20 per generation for outputs <=40s (spec's
  // Gemini research). Priced with margin: 25 credits = $0.25. (Was 250_000 — the
  // dollars-for-cents slip.)
  { resourceType: 'lipsync_generation', subject: 'fal-ai/latentsync',
    pricingSchema: { per_call_micro: 25_000_000 } },
  // Sync Labs sync-2.0: $0.08/output-second; priced flat assuming a
  // worst-case ~30s ad (this skill's hard ceiling), same "flat per-call,
  // not metered" convention generateVideo.ts already uses for its own
  // duration-variable pricing. 250 credits = $2.50 against $2.40 for 30s — a thin margin.
  // (Was 2_500_000 — the dollars-for-cents slip.)
  { resourceType: 'lipsync_generation', subject: 'sync-2.0',
    pricingSchema: { per_call_micro: 250_000_000 } },
  // assemble_clips is pure local ffmpeg compute — no vendor cost. Priced at
  // a small flat rate rather than zero, per the spec's open question:
  // resolveRate() finding no rate at all makes shouldRequireApproval() skip
  // the approval card silently (treated as "free, no charge" rather than
  // "no card, but still gated") — a tiny non-zero rate keeps this tool on
  // the same charge/approval code path as every other generation tool
  // instead of carving out a new no-approval code path for one tool.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-local',
    pricingSchema: { per_call_micro: 1_000 } },
  // Gemini transcription for animation-character's caption pipeline: short
  // (<=30s) audio/video, inline-base64 request, structured JSON output.
  // Priced flat per call, matching every other row's per_call_micro shape —
  // no existing row uses per-token/per-duration pricing and this does not
  // introduce one either. $0.02-ish estimate at Gemini 2.5 Flash rates for
  // a 30s clip plus margin. 1.5 credits = $0.015. (Was 15_000 — the dollars-for-cents slip.)
  { resourceType: 'audio_transcription', subject: 'gemini-transcribe',
    pricingSchema: { per_call_micro: 1_500_000 } },
  // animation-character's four new local-ffmpeg steps. Same "pure local
  // compute, small flat non-zero rate" reasoning as the clip_assembly/
  // ffmpeg-local row above — keeps each tool on the normal charge/approval
  // code path instead of a silent no-charge/no-approval carve-out.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-mux-audio',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-composite-end-card',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-burn-captions',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-mix-music-bed',
    pricingSchema: { per_call_micro: 1_000 } },
  // short-drama-stitch's clip-trim step. Same "pure local compute, small
  // flat non-zero rate" reasoning as every other clip_assembly row above —
  // keeps the tool on the normal charge/approval code path instead of a
  // silent no-charge/no-approval carve-out. An unseeded row here doesn't
  // just leave the tool unbilled — shouldRequireApproval returns false
  // with no matching rate, so the tool would run free AND with no
  // approval card at all. This row must be seeded (pnpm db:seed) against
  // the deployed environment before a live run, same lesson skill 5
  // documented for its own rows.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-trim-clip',
    pricingSchema: { per_call_micro: 1_000 } },
  // overlay_text — same local-ffmpeg flat-rate reasoning; must be seeded
  // (pnpm db:seed) or the tool runs free with no approval card.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-overlay-text',
    pricingSchema: { per_call_micro: 1_000 } },
  // stretch_clip — same local-ffmpeg flat-rate reasoning; must be seeded
  // (pnpm db:seed) or the tool runs free with no approval card.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-stretch-clip',
    pricingSchema: { per_call_micro: 1_000 } },
  // Metering ships before pricing: these are deliberately free on day one so ops can
  // price them later without a deploy (spec section 3).
  { resourceType: 'message',   subject: '*', pricingSchema: { per_message_micro: 0 } },
  { resourceType: 'tool_call', subject: '*', pricingSchema: { per_call_micro: 0 } },
  { resourceType: 'skill_run', subject: '*', pricingSchema: { per_run_micro: 0 } },
] as const;

type RateRow = { version: number; isActive: boolean; pricingSchema: unknown };

/** Key-order-independent JSON, so a jsonb round trip never reads as a price change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What the seed does for one rate, given that rate's existing rows:
 * - none yet: insert version 1;
 * - the active row already has this price: nothing;
 * - otherwise: retire the active row and insert the next version with this price.
 * Rows are never edited in place — every past charge keeps pointing at the
 * rate_id and version it was billed at. This file is the source of truth: a
 * price set by hand in the database is replaced by the price here on the next seed.
 */
export function planRateChange(
  existing: RateRow[],
  pricingSchema: unknown,
): { action: 'insert'; version: number } | { action: 'none' } {
  if (existing.length === 0) return { action: 'insert', version: 1 };
  const active = existing.find((r) => r.isActive);
  if (active && canonical(active.pricingSchema) === canonical(pricingSchema)) return { action: 'none' };
  return { action: 'insert', version: Math.max(...existing.map((r) => r.version)) + 1 };
}

export async function seedCreditRates(db: typeof DB) {
  console.log('seeding credit rates');
  for (const r of RATES) {
    const match = and(eq(creditRates.resourceType, r.resourceType), eq(creditRates.subject, r.subject));
    const existing = await db.select().from(creditRates).where(match);
    const plan = planRateChange(existing, r.pricingSchema);
    if (plan.action === 'none') continue;
    await db.transaction(async (tx) => {
      await tx.update(creditRates).set({ isActive: false }).where(and(match, eq(creditRates.isActive, true)));
      await tx.insert(creditRates).values({ ...r, version: plan.version, isActive: true });
    });
    console.log(`  ${r.resourceType}/${r.subject}: now version ${plan.version}`);
  }
}
