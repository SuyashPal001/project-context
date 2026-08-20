import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { safeExtractSkillZip, safeExtractSkillTarball, SkillPackageError, type SafeSkillEntry } from '../lib/safeSkillZip';
import { parseSkillManifest } from '../lib/skillManifest';
import { fetchPublicUrl, SsrfBlockedError } from '../lib/ssrfGuard';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export type SkillImportSource =
  | { type: 'zip'; fileKey: string }
  | { type: 'github'; owner: string; repo: string; ref: string }
  | { type: 'url'; url: string };

export interface SkillImportPayload {
  tenantId: string;
  skillId: string;
  skillVersionId: string;
  version: number;
  source: SkillImportSource;
}

interface ExtractedPackage {
  entries: SafeSkillEntry[];
  manifestSource: string;
  skipped: { fileName: string; reason: string }[];
}

async function extractForSource(source: SkillImportSource): Promise<ExtractedPackage> {
  if (source.type === 'zip') {
    const obj = await s3.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: source.fileKey }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const result = await safeExtractSkillZip(Buffer.concat(chunks));
    return { entries: result.accepted, manifestSource: result.manifestSource, skipped: result.skipped };
  }

  if (source.type === 'github') {
    if (!GITHUB_SEGMENT_RE.test(source.owner) || !GITHUB_SEGMENT_RE.test(source.repo) || !GITHUB_SEGMENT_RE.test(source.ref)) {
      throw new SkillPackageError('GitHub owner, repo, and ref may only contain letters, digits, dots, dashes, and underscores');
    }
    // Anonymous, public-repos-only tarball fetch — no OAuth, no GitHub App
    // installation token. See Non-goals in the spec for why this doesn't
    // reuse lib/github.ts's installation-token flow.
    const tarballUrl = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
    const buffer = await fetchPublicUrl(tarballUrl);
    const result = await safeExtractSkillTarball(buffer);
    return { entries: result.accepted, manifestSource: result.manifestSource, skipped: result.skipped };
  }

  const buffer = await fetchPublicUrl(source.url);
  const result = await safeExtractSkillZip(buffer);
  return { entries: result.accepted, manifestSource: result.manifestSource, skipped: result.skipped };
}

export async function handleSkillImport(body: Record<string, unknown>): Promise<void> {
  const payload = body as unknown as SkillImportPayload;
  const { tenantId, skillId, skillVersionId, version, source } = payload;
  const s3Prefix = `skill-packages/${skillId}/${version}`;

  try {
    const { entries, manifestSource, skipped } = await extractForSource(source);
    const manifest = parseSkillManifest(manifestSource);

    for (const entry of entries) {
      await s3.send(new PutObjectCommand({
        Bucket: DOCUMENTS_BUCKET,
        Key: `${s3Prefix}/${entry.fileName}`,
        Body: entry.buffer,
      }));
    }

    await db.execute(sql`
      UPDATE skill_versions
      SET manifest = ${JSON.stringify(manifest)}::jsonb, s3_prefix = ${s3Prefix}, status = 'ready'
      WHERE id = ${skillVersionId}
    `);
    await db.execute(sql`
      UPDATE skills SET latest_version = GREATEST(latest_version, ${version}), updated_at = NOW()
      WHERE id = ${skillId}
    `);

    db.insert(auditLog).values({
      tenantId, actorId: 'system', actorType: 'system', action: 'skill_import_completed',
      resource: 'skill_version', resourceId: skillVersionId,
      metadata: { skillId, version, fileCount: entries.length, skipped: skipped.length },
      traceId: '',
    }).catch(() => {});
    console.log(`[skillImport] ready: skillId=${skillId} version=${version} files=${entries.length} skipped=${skipped.length}`);
  } catch (err) {
    // Safety rejections (zip bomb, path traversal, SSRF, missing manifest)
    // already carry a tenant-safe message. Anything else might leak
    // internals (S3 errors, stack traces) so it's logged in full but
    // replaced with a generic message in the row the UI reads.
    const isKnownSafetyRejection = err instanceof SkillPackageError || err instanceof SsrfBlockedError;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const failureReason = isKnownSafetyRejection ? rawMessage : 'Import failed — see server logs for details';

    await db.execute(sql`
      UPDATE skill_versions SET status = 'failed', failure_reason = ${failureReason}
      WHERE id = ${skillVersionId}
    `);

    db.insert(auditLog).values({
      tenantId, actorId: 'system', actorType: 'system', action: 'skill_import_failed',
      resource: 'skill_version', resourceId: skillVersionId,
      metadata: { skillId, version, error: rawMessage },
      traceId: '',
    }).catch(() => {});
    console.error(`[skillImport] failed: skillId=${skillId} version=${version} error=${rawMessage}`);
    // Deliberately not re-thrown — see Global Constraints.
  }
}
