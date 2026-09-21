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
  { resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash',
    pricingSchema: { per_call_micro: 400_000 } },
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
    pricingSchema: { per_call_micro: 400_000 } },
  // Cartesia sonic-3.5: ~$0.02 per 30s ad script (per spec's cost research,
  // $40-42/1M characters, ~500 chars max script = ~$0.021). Priced with
  // margin at a flat per-call rate rather than per-character, matching this
  // codebase's existing flat-per-call convention for narration-sized clips.
  { resourceType: 'narration_generation', subject: 'sonic-3.5',
    pricingSchema: { per_call_micro: 30_000 } },
  // fal.ai LatentSync: flat $0.20 per generation for outputs <=40s (spec's
  // Gemini research). Priced with margin.
  { resourceType: 'lipsync_generation', subject: 'fal-ai/latentsync',
    pricingSchema: { per_call_micro: 250_000 } },
  // Sync Labs sync-2.0: $0.08/output-second; priced flat assuming a
  // worst-case ~30s ad (this skill's hard ceiling), same "flat per-call,
  // not metered" convention generateVideo.ts already uses for its own
  // duration-variable pricing.
  { resourceType: 'lipsync_generation', subject: 'sync-2.0',
    pricingSchema: { per_call_micro: 2_500_000 } },
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
  // a 30s clip plus margin.
  { resourceType: 'audio_transcription', subject: 'gemini-transcribe',
    pricingSchema: { per_call_micro: 15_000 } },
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
