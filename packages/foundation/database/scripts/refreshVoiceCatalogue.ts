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

import { notInArray } from 'drizzle-orm';
import { db } from '../client';
import { voiceCatalogue, type VoiceAccent } from '../schema/creative';

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
  { name: 'Cathy', tagline: 'Coworker' },
  { name: 'Nandi', tagline: 'Poised Concierge', localPreviewAsset: '/creative/voices/nandi-poised-concierge.wav' },
  { name: 'Carson', tagline: 'Curious Conversationalist' },
  { name: 'Corey', tagline: 'Supportive Buddy' },
  { name: 'Connie', tagline: 'Candid Conversationalist' },
  { name: 'Theo', tagline: 'Modern Narrator' },
  { name: 'Asher', tagline: 'Podcaster' },
];

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
if (!key) throw new Error('CARTESIA_API_KEY is required');
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

  for (const curated of CURATED_VOICES) {
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

  console.log(`\nupserted ${upserted} of ${CURATED_VOICES.length} curated voice(s)`);

  // Prune rows this run didn't touch — a voice removed from CURATED_VOICES,
  // or re-pointed to a different Cartesia id, must stop being served. Only
  // safe to do when every curated voice resolved: a partial run (some
  // failures) must never delete rows for voices it simply failed to look up
  // this time, or a transient Cartesia error would wipe the catalogue.
  if (failures.length === 0 && seenProviderIds.length > 0) {
    const pruned = await db.delete(voiceCatalogue)
      .where(notInArray(voiceCatalogue.providerId, seenProviderIds))
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
