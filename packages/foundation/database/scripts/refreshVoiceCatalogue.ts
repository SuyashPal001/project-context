// packages/foundation/database/scripts/refreshVoiceCatalogue.ts
//
// Resolves each curated voice's Cartesia list-endpoint match to its provider
// id, then re-fetches that single voice with expand[]=preview_file_url —
// which returns a real URL where the list endpoint returns null for most of
// our curated voices — and upserts the result into voice_catalogue.
// Idempotent per row via onConflictDoUpdate, and also prunes: any row whose
// provider_id wasn't touched this run (a voice removed from CURATED_VOICES,
// or one whose Cartesia id changed) is deleted, so the table can't silently
// keep serving a voice this script no longer vouches for. Pruning only runs
// when every curated voice resolved successfully — a partial run must never
// delete rows for voices it simply failed to look up this time.
//
// Run with both CARTESIA_API_KEY and DATABASE_URL set explicitly — don't
// rely on ambient env (see backfillCredits.ts for why: apps/api/.env may
// point at a database you don't intend to touch):
//   CARTESIA_API_KEY=... DATABASE_URL=... pnpm --filter @serverless-saas/database refresh:voices
//
// It also upserts the curated Gemini TTS voices (GEMINI_VOICES below), which
// need no API call: their metadata is fixed here and their preview clips are
// bundled under apps/web/public/creative/voices/gemini/<id>/<language>.mp3.
// Without CARTESIA_API_KEY only the Gemini set is refreshed and Cartesia rows
// are left untouched. Pruning is per engine: only rows of an engine this run
// fully refreshed can be pruned.

import { notInArray } from 'drizzle-orm';
import { db } from '../client';
import { voiceCatalogue, voiceProviderOf, type VoiceAccent } from '../schema/creative';

interface CuratedVoice {
  name: string;
  tagline: string;
  localPreviewAsset?: string;
}

// Mirrors apps/web/app/api/creative/voices/curated.ts, which this script
// makes obsolete (deleted in a later task) — this is now the single source
// for "which voices we support." Name+tagline pairs matter: Cartesia's
// catalogue has distinct voices sharing a name (several Carson variants).
const CURATED_VOICES: readonly CuratedVoice[] = [
  { name: 'Lauren', tagline: 'Lively Narrator', localPreviewAsset: '/creative/voices/lauren-lively-narrator.wav' },
  { name: 'Cathy', tagline: 'Coworker', localPreviewAsset: '/creative/voices/cathy-coworker.wav' },
  { name: 'Nandi', tagline: 'Poised Concierge', localPreviewAsset: '/creative/voices/nandi-poised-concierge.wav' },
  { name: 'Carson', tagline: 'Curious Conversationalist', localPreviewAsset: '/creative/voices/carson-curious-conversationalist.wav' },
  { name: 'Corey', tagline: 'Supportive Buddy', localPreviewAsset: '/creative/voices/corey-supportive-buddy.wav' },
  { name: 'Connie', tagline: 'Candid Conversationalist', localPreviewAsset: '/creative/voices/connie-candid-conversationalist.wav' },
  { name: 'Theo', tagline: 'Modern Narrator', localPreviewAsset: '/creative/voices/theo-modern-narrator.wav' },
  { name: 'Asher', tagline: 'Podcaster', localPreviewAsset: '/creative/voices/asher-podcaster.wav' },
];

// Gemini 3.8 Flash TTS voices, picked by listening tests on 2026-10-03. Every
// Gemini voice speaks every language (accent rated native in Hindi and Spanish
// for all of them), so each row lists all preview languages. The Indian set is
// Google's "Commercial Voiceover" library (20-30-year-old Hinglish influencers);
// their names here are ours, since the library only numbers them.
const PREVIEW_LOCALES = ['en', 'ar', 'zh', 'fr', 'de', 'he', 'hi', 'it', 'ja', 'pt', 'es', 'ta', 'te', 'th'];
interface GeminiVoice { id: string; name: string; tagline: string; gender: 'feminine' | 'masculine'; country: string; description: string }
const GEMINI_VOICES: readonly GeminiVoice[] = [
  { id: 'en-in-commercial-2', name: 'Ananya', tagline: 'Breezy Creator', gender: 'feminine', country: 'IN', description: '24, Indian influencer voice, speaks Hinglish. Bright, breezy and youthful.' },
  { id: 'en-in-commercial-3', name: 'Isha', tagline: 'Confident Creator', gender: 'feminine', country: 'IN', description: '22, Indian influencer voice, speaks Hinglish. Confident and clear.' },
  { id: 'en-in-commercial-5', name: 'Pooja', tagline: 'Warm Talker', gender: 'feminine', country: 'IN', description: '30, Indian influencer voice, speaks Hinglish. Warm and engaging.' },
  { id: 'en-in-commercial-10', name: 'Riya', tagline: 'Polished Presenter', gender: 'feminine', country: 'IN', description: '26, Indian influencer voice, speaks Hinglish. Professional yet approachable.' },
  { id: 'en-in-commercial-1', name: 'Aditya', tagline: 'Fun Creator', gender: 'masculine', country: 'IN', description: '23, Indian influencer voice, speaks Hinglish. Enthusiastic, engaging and fun.' },
  { id: 'en-in-commercial-4', name: 'Karan', tagline: 'Calm Creator', gender: 'masculine', country: 'IN', description: '25, Indian influencer voice, speaks Hinglish. Calm, professional yet relaxed.' },
  { id: 'en-in-commercial-6', name: 'Rohan', tagline: 'Warm Talker', gender: 'masculine', country: 'IN', description: '26, Indian influencer voice, speaks Hinglish. Warm and engaging.' },
  { id: 'en-in-commercial-12', name: 'Vihaan', tagline: 'Light & Airy', gender: 'masculine', country: 'IN', description: '20, Indian influencer voice, speaks Hinglish. Light, airy and precise.' },
  { id: 'Leda', name: 'Leda', tagline: 'Youthful', gender: 'feminine', country: 'US', description: 'Youthful, natural young woman. Great for casual UGC voice notes.' },
  { id: 'Aoede', name: 'Aoede', tagline: 'Breezy', gender: 'feminine', country: 'US', description: 'Breezy, light and relaxed. Recommended for lifestyle content.' },
  { id: 'Callirrhoe', name: 'Callirrhoe', tagline: 'Easy-going', gender: 'feminine', country: 'US', description: 'Easy-going, relaxed and casual, like talking to a friend.' },
  { id: 'Sulafat', name: 'Sulafat', tagline: 'Warm', gender: 'feminine', country: 'US', description: 'Warm and reassuring. Good for wellness and heartfelt stories.' },
  { id: 'Puck', name: 'Puck', tagline: 'Upbeat', gender: 'masculine', country: 'US', description: 'Upbeat and energetic. Good for lively product hooks.' },
  { id: 'Achird', name: 'Achird', tagline: 'Friendly', gender: 'masculine', country: 'US', description: 'Friendly, approachable and warm, with a lower-middle pitch.' },
  { id: 'Zubenelgenubi', name: 'Zubenelgenubi', tagline: 'Casual', gender: 'masculine', country: 'US', description: 'Casual and laid-back, like a real guy chatting.' },
  { id: 'Sadachbia', name: 'Sadachbia', tagline: 'Lively', gender: 'masculine', country: 'US', description: 'Lively and expressive. Good for excited testimonials.' },
];

async function refreshGemini(seen: string[]): Promise<number> {
  for (const voice of GEMINI_VOICES) {
    const row = {
      providerId: voice.id,
      name: voice.name,
      tagline: voice.tagline,
      language: null,
      gender: voice.gender,
      country: voice.country,
      description: voice.description,
      accents: PREVIEW_LOCALES.map(locale => ({ accent: voice.country === 'IN' ? 'Indian' : 'General', locale, is_native: true })),
      previewFileUrl: null,
      localPreviewAsset: `/creative/voices/gemini/${voice.id}/en.mp3`,
      refreshedAt: new Date(),
    };
    await db.insert(voiceCatalogue).values(row).onConflictDoUpdate({ target: voiceCatalogue.providerId, set: row });
    seen.push(voice.id);
    console.log(`upserted Gemini ${voice.name} / ${voice.tagline} -> ${voice.id}`);
  }
  return GEMINI_VOICES.length;
}

interface CartesiaListVoice {
  id: string;
  name: string;
  tagline?: string;
}

interface CartesiaVoiceDetail {
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  language?: string;
  gender?: string;
  country?: string;
  accents?: VoiceAccent[];
  preview_file_url?: string | null;
}

const key = process.env.CARTESIA_API_KEY;
const headers = { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' };

async function findProviderId(curated: CuratedVoice): Promise<string | undefined> {
  const url = new URL('https://api.cartesia.ai/voices');
  url.searchParams.set('limit', '20');
  url.searchParams.set('language', 'en');
  url.searchParams.set('q', curated.name);
  // No expand[]=preview_file_url here: this call only resolves name+tagline
  // to a provider id, and the list endpoint's preview_file_url is exactly
  // the field this whole script exists to route around (it's unreliable
  // here — the single-voice fetchDetail() call below is the reliable one).
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`list lookup failed for ${curated.name}: ${response.status}`);
  const payload = await response.json() as { data?: CartesiaListVoice[] };
  return payload.data?.find(voice =>
    voice.name.toLowerCase() === curated.name.toLowerCase()
    && voice.tagline?.toLowerCase() === curated.tagline.toLowerCase()
  )?.id;
}

async function fetchDetail(id: string): Promise<CartesiaVoiceDetail> {
  const url = new URL(`https://api.cartesia.ai/voices/${encodeURIComponent(id)}`);
  url.searchParams.append('expand[]', 'preview_file_url');
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`detail lookup failed for ${id}: ${response.status}`);
  return response.json() as Promise<CartesiaVoiceDetail>;
}

async function run() {
  let upserted = 0;
  const failures: string[] = [];
  const seenProviderIds: string[] = [];

  upserted += await refreshGemini(seenProviderIds);
  if (!key) console.log('\nCARTESIA_API_KEY not set: skipping Cartesia voices (their rows are left as they are)');

  for (const curated of key ? CURATED_VOICES : []) {
    try {
      const providerId = await findProviderId(curated);
      if (!providerId) {
        failures.push(`${curated.name} / ${curated.tagline}: no match in Cartesia's list endpoint`);
        continue;
      }
      const detail = await fetchDetail(providerId);
      // detail.name/.tagline fall back to the curated values (not left
      // undefined) so a Cartesia response that omits them can't violate the
      // table's NOT NULL constraint and abort the insert with a raw DB error.
      const row = {
        providerId,
        name: detail.name ?? curated.name,
        tagline: detail.tagline ?? curated.tagline,
        language: detail.language ?? null,
        gender: detail.gender ?? null,
        country: detail.country ?? null,
        description: detail.description ?? null,
        accents: detail.accents ?? null,
        previewFileUrl: detail.preview_file_url ?? null,
        localPreviewAsset: curated.localPreviewAsset ?? null,
        refreshedAt: new Date(),
      };
      await db.insert(voiceCatalogue).values(row).onConflictDoUpdate({
        target: voiceCatalogue.providerId,
        set: row,
      });
      seenProviderIds.push(providerId);
      console.log(`upserted ${curated.name} / ${curated.tagline} -> ${providerId} (preview_file_url: ${detail.preview_file_url ? 'set' : 'null'})`);
      upserted += 1;
    } catch (err) {
      failures.push(`${curated.name} / ${curated.tagline}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nupserted ${upserted} of ${GEMINI_VOICES.length + (key ? CURATED_VOICES.length : 0)} curated voice(s)`);

  // Prune rows this run didn't touch — a voice removed from CURATED_VOICES,
  // or re-pointed to a different Cartesia id, must stop being served. Only
  // safe to do when every curated voice resolved: a partial run (some
  // failures) must never delete rows for voices it simply failed to look up
  // this time, or a transient Cartesia error would wipe the catalogue.
  if (failures.length === 0 && seenProviderIds.length > 0) {
    // Only engines refreshed in full this run are prunable: without a Cartesia
    // key, Cartesia rows were not looked up, so they must not count as stale.
    const refreshed = new Set(key ? ['gemini', 'cartesia'] : ['gemini']);
    const keep = (await db.select({ providerId: voiceCatalogue.providerId }).from(voiceCatalogue))
      .map(row => row.providerId)
      .filter(id => seenProviderIds.includes(id) || !refreshed.has(voiceProviderOf(id)));
    const pruned = await db.delete(voiceCatalogue)
      .where(notInArray(voiceCatalogue.providerId, keep))
      .returning({ providerId: voiceCatalogue.providerId, name: voiceCatalogue.name });
    if (pruned.length > 0) {
      console.log(`pruned ${pruned.length} stale row(s): ${pruned.map(p => `${p.name} (${p.providerId})`).join(', ')}`);
    }
  } else if (failures.length > 0) {
    console.log('\nskipping prune: this run had failures, so a stale row might just be a transient lookup miss');
  }

  if (failures.length > 0) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
  }
  // Explicit exit: the shared @serverless-saas/database client is a pooled postgres.js
  // connection opened at import time with no idle timeout and no handle to .end() it
  // here, so without this the process hangs after a successful run (same reason as
  // backfillCredits.ts).
  process.exit(failures.length > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('refresh failed', err);
  process.exit(1);
});
