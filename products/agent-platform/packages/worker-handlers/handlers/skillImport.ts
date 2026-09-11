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

// Same abuse ceiling as the API's attach route
// (products/agent-platform/packages/api/routes/agent-skills.ts). This raw-SQL
// attach has no route in front of it, so it enforces the cap itself.
// Deliberately duplicated rather than shared — see the route file's comment.
const MAX_ATTACHED_SKILLS = 8;

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
    // An install is attached at most once per agent, enforced by the partial
    // unique index agent_skills_agent_install_active_unique on
    // (agent_id, install_id) WHERE install_id IS NOT NULL AND status = 'active'.
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
        // Same 100-char cap as the route (agent-skills.ts) — the worker must
        // store and match the same value the route would, since either can
        // reactivate the other's row.
        const attachName = manifest.name.slice(0, 100);

        // The cap counts the agent's *other* attached skills, excluding rows
        // whose install has since been uninstalled (dead installs don't
        // count against the cap — same predicate the route's GET and cap use).
        // The 'default' row (name='default' AND install_id IS NULL) is the
        // agent's base prompt, not a skill (TRANSITION: migration 0092
        // deletes those rows; Task 13 removes this filter), and this
        // install's own row never counts against its re-attach.
        const countRows = ((await db.execute(sql`
          SELECT count(*)::int AS n
          FROM agent_skills s
          LEFT JOIN skill_installs si ON si.id = s.install_id AND si.tenant_id = ${tenantId}::uuid
          WHERE s.agent_id = ${attachToAgentId}::uuid AND s.tenant_id = ${tenantId}::uuid
            AND s.status = 'active'
            AND NOT (s.name = 'default' AND s.install_id IS NULL)
            AND (s.install_id IS NULL OR si.status = 'active')
            AND s.install_id IS DISTINCT FROM (
              SELECT si2.id FROM skill_installs si2
              WHERE si2.skill_id = ${skillId}::uuid AND si2.tenant_id = ${tenantId}::uuid AND si2.status = 'active'
              LIMIT 1
            )
        `)) ?? []) as unknown as { n: number }[];
        const otherCount = Number(countRows[0]?.n ?? 0);

        if (otherCount >= MAX_ATTACHED_SKILLS) {
          console.log(`[skillImport] attach skipped: agent already has ${MAX_ATTACHED_SKILLS} skills agentId=${attachToAgentId} skillId=${skillId} version=${version}`);
        } else {
          // An install is attached at most once per agent. Reuse its existing
          // row, active or archived, so a re-import or a re-attach after a
          // detach reactivates it. Both joins are tenant constraints:
          // agent_skills.agent_id and tenant_id are independent foreign keys,
          // so a row pairing this tenant with another tenant's agent must
          // match nothing.
          //
          // This UPDATE deliberately never renames the row (no `name =`
          // assignment) and never touches `version`: the old (agent_id,
          // tenant_id, name, version) unique constraint still exists and
          // still covers archived rows, so setting either could collide
          // permanently with an archived row that already holds that
          // name/version pair — e.g. an active bid-writer v1 row for this
          // install plus an archived bid-writer v2 row: reactivating v1 to
          // version=2 here would raise 23505 forever. agent_skills.version
          // is only a dedupe tiebreak; installed content resolves from
          // si.installed_version. The route does the same at
          // agent-skills.ts (its reactivation `.set(...)` only touches
          // systemPrompt, status, updatedAt).
          const reactivated = ((await db.execute(sql`
            UPDATE agent_skills s
            SET status = 'active', system_prompt = ${manifestWithBody.body}, updated_at = now()
            WHERE s.id = (
              SELECT s2.id FROM agent_skills s2
              JOIN agents a ON a.id = s2.agent_id AND a.tenant_id = ${tenantId}::uuid
              JOIN skill_installs si ON si.id = s2.install_id
                AND si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
              WHERE s2.agent_id = ${attachToAgentId}::uuid AND s2.tenant_id = ${tenantId}::uuid
              ORDER BY (s2.status = 'active') DESC, s2.created_at ASC
              LIMIT 1
            )
            RETURNING s.id
          `)) ?? []) as unknown as { id: string }[];

          if (reactivated.length === 0) {
            // No row exists yet for this install. But an ARCHIVED row may
            // already hold this exact name and version — left over from a
            // detach under the old, pre-install_id attach path, or from a
            // prior import of the same skill that got archived. The old
            // (agent_id, tenant_id, name, version) unique constraint still
            // covers archived rows, so inserting a fresh row with that same
            // name/version would collide. Reuse it instead.
            //
            // The row to update is picked by id from a single-row subselect
            // (not a bare filtered UPDATE) so that once migration 0092 drops
            // the old (name, version) constraint, several archived rows
            // matching the same name/version can no longer all get revived
            // onto the same install_id at once (which the active-install
            // partial index would then reject outright, blocking the attach
            // for good). Both tenant constraints are independent foreign
            // keys on agent_skills, so both are checked directly
            // (s2.tenant_id) and via the agents join (a.tenant_id) — a row
            // pairing this tenant with another tenant's agent matches
            // nothing. si.tenant_id constrains which install's id gets
            // written.
            // Without the EXISTS guard below, a missing active install
            // (reachable: the API can enqueue this import before the
            // skill_installs row commits) would leave the scalar
            // install_id subselect NULL while still reviving the row —
            // status='active', install_id=NULL, a phantom hand-authored
            // skill. The guard makes the whole UPDATE match zero rows
            // instead, so it falls through to the INSERT (which itself
            // writes nothing without an active install) and the existing
            // zero-rows warning covers it.
            const archivedReactivated = ((await db.execute(sql`
              UPDATE agent_skills s
              SET install_id = (
                    SELECT si.id FROM skill_installs si
                    WHERE si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
                    LIMIT 1
                  ),
                  system_prompt = ${manifestWithBody.body}, status = 'active', updated_at = now()
              WHERE s.id = (
                SELECT s2.id FROM agent_skills s2
                JOIN agents a ON a.id = s2.agent_id AND a.tenant_id = ${tenantId}::uuid
                WHERE s2.agent_id = ${attachToAgentId}::uuid AND s2.tenant_id = ${tenantId}::uuid
                  AND s2.name = ${attachName} AND s2.version = ${version} AND s2.status = 'archived'
                ORDER BY s2.created_at ASC
                LIMIT 1
              )
              AND EXISTS (
                SELECT 1 FROM skill_installs si
                WHERE si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
              )
              RETURNING s.id
            `)) ?? []) as unknown as { id: string }[];

            if (archivedReactivated.length === 0) {
              // The agents join is a security constraint, not a convenience:
              // selecting a.id FROM agents WHERE a.tenant_id = tenantId makes a
              // mismatched agent/tenant pair write zero rows. This raw insert
              // has no route in front of it on a queue redelivery.
              const result = await db.execute(sql`
                INSERT INTO agent_skills (agent_id, tenant_id, name, system_prompt, tools, version, status, install_id)
                SELECT a.id, a.tenant_id, ${attachName}, ${manifestWithBody.body}, '{}', ${version},
                       'active', si.id
                FROM agents a
                JOIN skill_installs si
                  ON si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
                WHERE a.id = ${attachToAgentId}::uuid AND a.tenant_id = ${tenantId}::uuid
                ON CONFLICT (agent_id, install_id) WHERE install_id IS NOT NULL AND status = 'active' DO NOTHING
              `);
              // Zero rows affected means one of three things: the ON CONFLICT
              // no-op (a benign redelivery), no active skill_installs row yet
              // for this skill, or an agent outside this tenant, which the join
              // refuses. All three are a silent no-attach unless logged.
              const affected = (result as unknown as { count?: number; length?: number })?.count
                ?? (result as unknown as { length?: number })?.length
                ?? 0;
              if (affected === 0) {
                console.warn(`[skillImport] attach affected 0 rows (agent not in tenant, no matching active skill_installs row, or already attached): agentId=${attachToAgentId} tenantId=${tenantId} skillId=${skillId} version=${version}`);
              }
            }
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
