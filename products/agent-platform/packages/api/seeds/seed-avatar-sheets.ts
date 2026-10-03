/**
 * Gives every platform library avatar (Mira, Divya, ...) a reference sheet —
 * front, both three-quarter views, profile and full body of the same person —
 * so image and video generation keep the face stable instead of rebuilding it
 * from one portrait. Tenant avatars already get a sheet from the avatar
 * creators; library avatars had none (2026-10-03: Divya's face drifted badly
 * from a single lying-down photo).
 *
 * The sheets live next to this file at seeds/avatar-sheets/<slug>.jpg (generated
 * once from each avatar's portrait with Codex, 1600px wide). Not under
 * apps/web/public: they are references for generation, not public site assets. For each one this:
 *   1. uploads it to s3://<bucket>/creative-library/avatar-sheets/<slug>.jpg
 *   2. upserts a platform row for it with status 'reference' — fetchable by id
 *      as an image reference, never listed in pickers or casting lists
 *   3. sets referenceSheetAssetId on the avatar row (merged into attributes)
 * avatarReferences.ts then adds the sheet next to the portrait automatically.
 *
 * Idempotent: the sheet row id is derived from the avatar slug.
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:avatar-sheets
 */
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import postgres from 'postgres';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getBucketFromSSM } from '@serverless-saas/storage';

const sheetsDir = join(dirname(fileURLToPath(import.meta.url)), 'avatar-sheets');

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const bucket = await getBucketFromSSM();
  if (!bucket) throw new Error('Unable to resolve documents bucket (DOCUMENTS_BUCKET / SSM param empty)');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  const sql = postgres(url, { max: 1 });
  let done = 0, missing = 0;
  try {
    const avatars = await sql<{ id: string; slug: string; name: string }[]>`
      SELECT id, slug, name FROM creative_library_assets
      WHERE tenant_id IS NULL AND kind = 'avatar' AND status = 'active'`;
    for (const a of avatars) {
      const localPath = join(sheetsDir, `${a.slug}.jpg`);
      if (!existsSync(localPath)) { missing++; console.log(`[seed:avatar-sheets] no sheet for ${a.slug}, skipped`); continue; }
      const key = `creative-library/avatar-sheets/${a.slug}.jpg`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(localPath), ContentType: 'image/jpeg' }));
      const [sheet] = await sql<{ id: string }[]>`
        INSERT INTO creative_library_assets (id, tenant_id, slug, kind, name, attributes, storage_key, mime_type, status)
        VALUES (md5(${'avatar-sheet:' + a.slug})::uuid, NULL, ${a.slug + '-sheet'}, 'avatar', ${a.name + ' reference'},
                ${sql.json({ sheetOf: a.id })}, ${key}, 'image/jpeg', 'reference')
        ON CONFLICT (id) DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = now()
        RETURNING id`;
      await sql`
        UPDATE creative_library_assets
        SET attributes = attributes || ${sql.json({ referenceSheetAssetId: sheet.id })}, updated_at = now()
        WHERE id = ${a.id}`;
      done++;
      console.log(`[seed:avatar-sheets] ${a.slug} -> ${sheet.id}`);
    }
    console.log(`[seed:avatar-sheets] ${done} sheets linked, ${missing} avatars without a sheet file`);
  } finally {
    await sql.end();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  run().catch((err) => {
    console.error('[seed:avatar-sheets] failed', err);
    process.exit(1);
  });
}
