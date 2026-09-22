/**
 * Seeds the six avatar presets as platform-owned creative_library_assets
 * rows, each pointing at a real S3 object under a platform-owned prefix
 * (not a tenant's files table).
 *
 * The bytes for each row must already exist in S3 at
 * `creative-library/avatars/{slug}.jpg` before this seed is meaningful —
 * see this file's `uploadSeedImages` for a one-time upload of the same
 * 6 JPGs already bundled at apps/web/public/creative/avatars/*.jpg.
 *
 * Idempotent: safe to re-run.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:creative-library-assets
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import postgres from 'postgres';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Fixed, not gen_random_uuid() — the web app's creativeLibraryAvatars.ts
// hardcodes these same values as each preset's assetId, so a picked
// preset's fileId is known client-side without any DB read. Regenerating
// these would silently break every existing chat message that references
// one.
export interface AvatarAssetSeed {
  id: string;
  slug: string;
  name: string;
  role: string;
  tone: string;
  localImagePath: string; // relative to apps/web/public
}

export const AVATAR_ASSETS: AvatarAssetSeed[] = [
  { id: '557e5751-adbb-4b4e-8b08-8e426e0ffcf5', slug: 'everyday-creator', name: 'Mira', role: 'Everyday creator', tone: 'Casual', localImagePath: 'creative/avatars/everyday-creator.jpg' },
  { id: '8b6e9254-cc47-492c-bdc7-557ac6302e01', slug: 'tech-presenter', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', localImagePath: 'creative/avatars/tech-presenter.jpg' },
  { id: '7df4d729-3611-4b15-8c49-ca691f2001b5', slug: 'beauty-creator', name: 'Hana', role: 'Beauty creator', tone: 'Natural', localImagePath: 'creative/avatars/beauty-creator.jpg' },
  { id: '5f328586-1b58-4bf6-af32-de4d4b3dc14d', slug: 'fitness-host', name: 'Samir', role: 'Fitness host', tone: 'Upbeat', localImagePath: 'creative/avatars/fitness-host-gym.jpg' },
  { id: '90e08f84-458e-472f-8c04-8da7860d2afe', slug: 'lifestyle-creator', name: 'Priya', role: 'Lifestyle creator', tone: 'Friendly', localImagePath: 'creative/avatars/lifestyle-creator-home.jpg' },
  { id: '78d215f5-5a6d-43f2-acac-4de02611dea4', slug: 'friendly-storyteller', name: 'Mateo', role: 'Friendly storyteller', tone: 'Conversational', localImagePath: 'creative/avatars/friendly-storyteller.jpg' },
];

function storageKeyFor(slug: string): string {
  return `creative-library/avatars/${slug}.jpg`;
}

async function uploadSeedImages(): Promise<void> {
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET is not set');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  // From this file's directory (products/agent-platform/packages/api/seeds/),
  // '../../../../..' climbs 5 levels to the repo root, then into apps/web/public.
  const webPublicDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/web/public');

  for (const a of AVATAR_ASSETS) {
    const bytes = readFileSync(join(webPublicDir, a.localImagePath));
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKeyFor(a.slug),
      Body: bytes,
      ContentType: 'image/jpeg',
    }));
    console.log(`[seed:creative-library-assets] uploaded ${a.slug} to s3://${bucket}/${storageKeyFor(a.slug)}`);
  }
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  await uploadSeedImages();

  const sql = postgres(url, { max: 1 });
  try {
    for (const a of AVATAR_ASSETS) {
      await sql`
        INSERT INTO creative_library_assets (
          id, tenant_id, slug, kind, name, attributes, storage_key, mime_type, status
        ) VALUES (
          ${a.id}, NULL, ${a.slug}, 'avatar', ${a.name},
          ${sql.json({ role: a.role, tone: a.tone })}, ${storageKeyFor(a.slug)}, 'image/jpeg', 'active'
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          attributes = EXCLUDED.attributes,
          storage_key = EXCLUDED.storage_key,
          updated_at = now()
      `;
      console.log(`[seed:creative-library-assets] upserted ${a.slug}`);
    }
  } finally {
    await sql.end();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  run().catch((err) => {
    console.error('[seed:creative-library-assets] failed', err);
    process.exit(1);
  });
}
