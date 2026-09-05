import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { safeExtractSkillZip, safeExtractSkillTarball, SkillPackageError, type SafeSkillEntry } from '../lib/safeSkillZip';
import { parseSkillManifest, stripSkillManifestFrontmatter, SkillManifestError } from '../lib/skillManifest';
import { fetchPublicUrl, SsrfBlockedError } from '../lib/ssrfGuard';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
// auditLog is readable (and CSV-exportable) by any tenant admin holding
// audit_log:read, so the raw error stored here is tenant-visible even though
// failure_reason is sanitised. Full detail stays in the server log; the row
// keeps only enough to correlate.
const AUDIT_ERROR_MAX = 200;

function truncateForAudit(message: string): string {
  return message.length > AUDIT_ERROR_MAX ? `${message.slice(0, AUDIT_ERROR_MAX)}…` : message;
}

export type SkillImportSource =
  | { type: 'zip'; fileKey: string }
  | { type: 'github'; owner: string; repo: string; ref: string }
  | { type: 'url'; url: string }
  | { type: 'authored'; body: string };

export interface SkillImportPayload {
  tenantId: string;
  skillId: string;
  skillVersionId: string;
  version: number;
  source: SkillImportSource;
  /** Set only by the in-conversation create path: attach the skill to this
   *  agent once the version is ready. */
  attachToAgentId?: string;
}

// Mirrors MAX_ATTACHED_SKILLS / MAX_COMPOSED_SKILL_CHARS in
// products/agent-platform/packages/api/routes/agent-skills.ts (which itself
// mirrors the orchestrator's usage.ts). This raw-SQL insert bypasses that
// route's guard entirely, so it has to re-enforce the same caps or it becomes
// the one attach path that can push an agent past them. Deliberately
// duplicated rather than shared — see the route file's comment.
const MAX_ATTACHED_SKILLS = 8;
const MAX_COMPOSED_SKILL_CHARS = 24_000;

interface ExtractedPackage {
  entries: SafeSkillEntry[];
  manifestSource: string;
  skipped: { fileName: string; reason: string }[];
}

async function extractForSource(source: SkillImportSource): Promise<ExtractedPackage> {
  // Authored skills arrive with their SKILL.md inline — nothing to download,
  // unpack, or defend against. They deliberately still flow through this
  // handler rather than being written straight from the API route: manifest
  // parsing, the S3 layout, and the pending→ready/failed transitions all live
  // here, and a second copy of that in the Lambda could drift from the one
  // the runtime actually trusts.
  if (source.type === 'authored') {
    return {
      entries: [{ fileName: 'SKILL.md', buffer: Buffer.from(source.body, 'utf8') }],
      manifestSource: source.body,
      skipped: [],
    };
  }

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
  const { tenantId, skillId, skillVersionId, version, source, attachToAgentId } = payload;
  const s3Prefix = `skill-packages/${skillId}/${version}`;

  try {
    const { entries, manifestSource, skipped } = await extractForSource(source);
    const manifest = parseSkillManifest(manifestSource);
    // Body is stored alongside the parsed frontmatter fields so the detail view can
    // render the authored SKILL.md content without a separate S3 read on every view.
    const manifestWithBody = { ...manifest, body: stripSkillManifestFrontmatter(manifestSource) };

    for (const entry of entries) {
      await s3.send(new PutObjectCommand({
        Bucket: DOCUMENTS_BUCKET,
        Key: `${s3Prefix}/${entry.fileName}`,
        Body: entry.buffer,
      }));
    }

    await db.execute(sql`
      UPDATE skill_versions
      SET manifest = ${JSON.stringify(manifestWithBody)}::jsonb, s3_prefix = ${s3Prefix}, status = 'ready'
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

    // Attaching here rather than polling from the caller: this is the moment
    // the version becomes usable, the parsed body is already in hand, and the
    // attach survives the user closing the tab.
    //
    // agent_skills is unique on (agent_id, tenant_id, name, version) — the
    // version must be the one just imported, or a legitimate re-attach of a
    // later version collides with this row.
    // Given its own try/catch: the import above already fully succeeded (S3
    // writes done, version 'ready', skills.latest_version bumped,
    // skill_import_completed audited). A malformed attachToAgentId (not
    // validated as a UUID before this point) or a deleted/foreign agent id
    // can throw here (22P02, FK violation) — that must not fall into the
    // outer catch and flip an already-successful import to 'failed' with
    // contradictory audit rows. An attach failure is logged and swallowed;
    // the import's own success stands regardless.
    if (attachToAgentId) {
      try {
        // Same budget check as the API's attach route (see MAX_ATTACHED_SKILLS
        // comment above). This raw insert has no route in front of it, so the
        // check has to happen here or the cap has no enforcement on this path.
        const existing = ((await db.execute(sql`
          SELECT name, system_prompt AS "systemPrompt", version
          FROM agent_skills
          WHERE agent_id = ${attachToAgentId}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'active'
        `)) ?? []) as { name: string; systemPrompt: string | null; version: number | null }[];

        // Exclude only the row(s) this attach supersedes — same name, version
        // <= the incoming version — mirroring the route's exclusion. A
        // same-name row at a higher version still composes regardless of this
        // attach and must stay counted.
        const others = existing.filter((s) => s.name !== manifest.name || (s.version ?? 1) > version);

        // Mirrors the orchestrator's per-skill cost: the composed prompt wraps
        // each skill's trimmed body in a "## Skill: <name>\n\n" header, so the
        // raw body length under-counts by name.length + 15.
        const cost = (p: string, n: string) => (p?.trim().length ?? 0) + n.length + 15;
        const composedChars = others.reduce((n, s) => n + cost(s.systemPrompt ?? '', s.name), 0);
        const newCost = cost(manifestWithBody.body, manifest.name);

        if (others.length >= MAX_ATTACHED_SKILLS || composedChars + newCost > MAX_COMPOSED_SKILL_CHARS) {
          console.log(`[skillImport] attach skipped: budget exceeded agentId=${attachToAgentId} skillId=${skillId} version=${version}`);
        } else {
          const result = await db.execute(sql`
            INSERT INTO agent_skills (agent_id, tenant_id, name, system_prompt, tools, version, status, install_id)
            SELECT ${attachToAgentId}::uuid, ${tenantId}::uuid, ${manifest.name}, ${manifestWithBody.body}, '{}', ${version},
                   'active', si.id
            FROM skill_installs si
            WHERE si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
            ON CONFLICT (agent_id, tenant_id, name, version) DO NOTHING
          `);
          // Zero rows affected means either the ON CONFLICT no-op (a benign
          // redelivery) or — because the SELECT's FROM skill_installs finds
          // nothing — that no active install row exists yet for this skill
          // (the API can enqueue the import before the install row commits).
          // Either way this is a silent no-attach unless logged.
          const affected = (result as unknown as { count?: number; length?: number })?.count
            ?? (result as unknown as { length?: number })?.length
            ?? 0;
          if (affected === 0) {
            console.warn(`[skillImport] attach affected 0 rows (no matching active skill_installs row, or already attached): agentId=${attachToAgentId} skillId=${skillId} version=${version}`);
          }
        }
      } catch (attachErr) {
        const attachMessage = attachErr instanceof Error ? attachErr.message : String(attachErr);
        console.error(`[skillImport] attach failed: agentId=${attachToAgentId} skillId=${skillId} version=${version} error=${attachMessage}`);
      }
    }
  } catch (err) {
    // Safety rejections (zip bomb, path traversal, SSRF, missing manifest,
    // invalid/missing SKILL.md frontmatter) already carry a tenant-safe
    // message describing a problem with the tenant's own package — no infra
    // details leak either way. Anything else might leak internals (S3
    // errors, stack traces) so it's logged in full but replaced with a
    // generic message in the row the UI reads.
    const isKnownSafetyRejection =
      err instanceof SkillPackageError || err instanceof SsrfBlockedError || err instanceof SkillManifestError;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const failureReason = isKnownSafetyRejection ? rawMessage : 'Import failed — see server logs for details';

    await db.execute(sql`
      UPDATE skill_versions SET status = 'failed', failure_reason = ${failureReason}
      WHERE id = ${skillVersionId}
    `);

    db.insert(auditLog).values({
      tenantId, actorId: 'system', actorType: 'system', action: 'skill_import_failed',
      resource: 'skill_version', resourceId: skillVersionId,
      metadata: { skillId, version, error: truncateForAudit(rawMessage) },
      traceId: '',
    }).catch(() => {});
    console.error(`[skillImport] failed: skillId=${skillId} version=${version} error=${rawMessage}`);
    // Deliberately not re-thrown — see Global Constraints.
  }
}
