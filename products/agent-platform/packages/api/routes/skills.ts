import { Hono } from 'hono';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../db';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { publishToQueue } from '@serverless-saas/queue';
import type { AppEnv } from '@serverless-saas/types';

export const skillsRoutes = new Hono<AppEnv>();
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('zip'), fileKey: z.string().min(1).max(512) }),
  z.object({ type: z.literal('github'), owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), ref: z.string().min(1).max(100) }),
  z.object({ type: z.literal('url'), url: z.string().url().max(2048) }),
]);

const uuidSchema = z.string().uuid();
const SKILL_TABS = ['mine', 'official', 'public', 'installed'] as const;
type SkillTab = (typeof SKILL_TABS)[number];

const INTERNAL_ERROR = { error: 'Internal error', code: 'INTERNAL_ERROR' } as const;

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
}

// A zip source's fileKey is caller-supplied, but the only legitimate value is
// one this tenant just got back from POST /skills/upload-url — which always
// lives under tenants/{tenantId}/skill-uploads/. Without this check a caller
// could point the import worker at any S3 key it can name (including another
// tenant's, whose keys leak through a public skill's version history) and have
// its contents copied into a skill package it owns.
function isOwnUploadKey(fileKey: string, tenantId: string | undefined): boolean {
  if (!tenantId) return false;
  if (fileKey.includes('..')) return false;
  return fileKey.startsWith(`tenants/${tenantId}/skill-uploads/`);
}

async function resolveSkill(skillId: string) {
  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  return skill ?? null;
}

// The creator's display name is safe to show anyone who can already see the
// skill; their email is not, so it follows the same owner-only rule the
// versions/list routes apply to failureReason.
async function resolveOwners(userIds: string[]): Promise<Map<string, { name: string; email: string }>> {
  const byId = new Map<string, { name: string; email: string }>();
  if (userIds.length === 0) return byId;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const row of rows) byId.set(row.id, { name: row.name, email: row.email });
  return byId;
}

async function createVersionAndEnqueue(params: {
  tenantId: string;
  skillId: string;
  version: number;
  source: z.infer<typeof sourceSchema>;
}) {
  const { tenantId, skillId, version, source } = params;
  const [versionRow] = await db.insert(skillVersions).values({
    skillId,
    version,
    s3Prefix: `skill-packages/${skillId}/${version}`,
    sourceType: source.type,
    sourceRef: source.type === 'zip' ? source.fileKey : source.type === 'url' ? source.url : `${source.owner}/${source.repo}@${source.ref}`,
    status: 'pending',
  }).returning();

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (queueUrl) {
    await publishToQueue(queueUrl, { type: 'skill.import', tenantId, skillId, skillVersionId: versionRow.id, version, source });
  }
  return versionRow;
}

// POST /skills/upload-url — presigned S3 upload, used before POST / or
// POST /:id with source.type === 'zip'
skillsRoutes.post('/upload-url', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const result = z.object({ fileName: z.string().min(1).max(255) }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

  const fileKey = `tenants/${tenantId}/skill-uploads/${crypto.randomUUID()}-${result.data.fileName}`;
  const command = new PutObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET!, Key: fileKey, ContentType: 'application/zip' });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  return c.json({ uploadUrl, fileKey });
});

// GET /skills?tab=mine|official|public|installed
//
// `installed` is deliberately not one of the three user-facing tabs on the
// dashboard: it is "every skill this tenant has an active install of",
// regardless of who owns it, which is what the agent attach picker needs.
// `mine` filters on ownerTenantId alone, so a public/official skill installed
// from another tenant never appears there.
skillsRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const requestedTab = c.req.query('tab') ?? 'mine';
  const tab: SkillTab = (SKILL_TABS as readonly string[]).includes(requestedTab) ? (requestedTab as SkillTab) : 'mine';

  // The left join below is already scoped to this tenant, so requiring an
  // active install row on it is an inner join in everything but name.
  const filter = tab === 'official' ? eq(skills.isOfficial, true)
    : tab === 'public' ? eq(skills.visibility, 'public')
    : tab === 'installed' ? eq(skillInstalls.status, 'active')
    : eq(skills.ownerTenantId, tenantId);

  try {
    const rows = await db
      .select({
        id: skills.id, name: skills.name, slug: skills.slug, description: skills.description,
        visibility: skills.visibility, isOfficial: skills.isOfficial, latestVersion: skills.latestVersion,
        downloadCount: skills.downloadCount,
        ownerTenantId: skills.ownerTenantId, createdBy: skills.createdBy, createdAt: skills.createdAt, updatedAt: skills.updatedAt,
        installId: skillInstalls.id,
        installedVersion: skillInstalls.installedVersion, installStatus: skillInstalls.status,
        runCount: skillInstalls.runCount,
      })
      .from(skills)
      .leftJoin(skillInstalls, and(eq(skillInstalls.skillId, skills.id), eq(skillInstalls.tenantId, tenantId)))
      .where(filter)
      .orderBy(desc(skills.createdAt));

    // Latest version row per skill, for the pending/ready/failed state the
    // card renders. Without it a failed import is indistinguishable from a
    // still-running one (both leave skills.latestVersion at 0), which the
    // spec explicitly calls out as the thing not to ship.
    const ids = rows.map((r) => r.id);
    const latestBySkill = new Map<string, { status: string | null; failureReason: string | null }>();
    if (ids.length > 0) {
      const versionRows = await db
        .selectDistinctOn([skillVersions.skillId], {
          skillId: skillVersions.skillId,
          status: skillVersions.status,
          failureReason: skillVersions.failureReason,
        })
        .from(skillVersions)
        .where(inArray(skillVersions.skillId, ids))
        .orderBy(skillVersions.skillId, desc(skillVersions.version));
      for (const v of versionRows) latestBySkill.set(v.skillId, { status: v.status, failureReason: v.failureReason });
    }

    const ownerById = await resolveOwners([...new Set(rows.map((r) => r.createdBy).filter(Boolean))]);

    return c.json({
      data: rows.map((r) => {
        const latest = latestBySkill.get(r.id);
        const { createdBy, ...rest } = r;
        const owner = ownerById.get(createdBy);
        return {
          ...rest,
          installed: r.installStatus === 'active',
          latestVersionStatus: latest?.status ?? null,
          ownerName: owner?.name ?? null,
          runCount: r.runCount ?? 0,
          ownerEmail: r.ownerTenantId === tenantId ? (owner?.email ?? null) : null,
          // failureReason can carry raw, tenant-specific detail (a blocked
          // hostname, manifest/zip contents) for several failure classes —
          // see GET /:id/versions below, which strips it from non-owners the
          // same way. latestVersionStatus stays visible to everyone; only the
          // free-text reason is owner-gated.
          failureReason: r.ownerTenantId === tenantId ? (latest?.failureReason ?? null) : null,
        };
      }),
    });
  } catch (err) {
    console.error('Failed to list skills:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// GET /skills/:id — single skill, same row shape as GET /skills. Used by the
// skill detail page, which a public/official skill's non-owner can also reach
// directly (e.g. a bookmarked link), so this applies the same
// owner/public/official visibility rule as the install and versions routes.
skillsRoutes.get('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    const isOwner = skill.ownerTenantId === tenantId;
    if (!isOwner && skill.visibility !== 'public' && !skill.isOfficial) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const [install] = await db.select().from(skillInstalls)
      .where(and(eq(skillInstalls.skillId, skillId), eq(skillInstalls.tenantId, tenantId)))
      .limit(1);

    const [latest] = await db.select({ status: skillVersions.status, failureReason: skillVersions.failureReason, manifest: skillVersions.manifest })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version))
      .limit(1);

    const ownerById = await resolveOwners([skill.createdBy]);
    const owner = ownerById.get(skill.createdBy);

    // Only a 'ready' version's manifest was written by a completed import — a
    // pending/failed row's manifest column is whatever the previous version left
    // (or null), so gate on status rather than trusting the field's mere presence.
    const body = latest?.status === 'ready' && latest.manifest && typeof latest.manifest === 'object'
      ? (latest.manifest as Record<string, unknown>).body
      : null;

    return c.json({
      data: {
        id: skill.id, name: skill.name, slug: skill.slug, description: skill.description,
        visibility: skill.visibility, isOfficial: skill.isOfficial, latestVersion: skill.latestVersion,
        downloadCount: skill.downloadCount,
        ownerTenantId: skill.ownerTenantId, ownerName: owner?.name ?? null, ownerEmail: isOwner ? (owner?.email ?? null) : null,
        createdAt: skill.createdAt, updatedAt: skill.updatedAt,
        installId: install?.id ?? null,
        installedVersion: install?.installedVersion ?? null,
        installed: install?.status === 'active',
        runCount: install?.runCount ?? 0,
        latestVersionStatus: latest?.status ?? null,
        failureReason: isOwner ? (latest?.failureReason ?? null) : null,
        body: typeof body === 'string' ? body : null,
      },
    });
  } catch (err) {
    console.error('Failed to get skill:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// POST /skills — create a new skill + version 1, enqueue import
skillsRoutes.post('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  const userId = c.get('userId') as string;
  if (!hasPermission(permissions, 'skills', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const schema = z.object({ name: z.string().min(1).max(100), description: z.string().max(2000).optional(), source: sourceSchema });
  const result = schema.safeParse(await c.req.json());
  if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

  const { name, description, source } = result.data;
  if (source.type === 'zip' && !isOwnUploadKey(source.fileKey, tenantId)) {
    return c.json({ error: 'fileKey does not belong to this tenant', code: 'VALIDATION_ERROR' }, 400);
  }

  const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const [skill] = await db.insert(skills).values({
      ownerTenantId: tenantId, name, slug, description: description ?? null,
      visibility: 'private', isOfficial: false, latestVersion: 0, createdBy: userId,
    }).returning();

    const versionRow = await createVersionAndEnqueue({ tenantId, skillId: skill.id, version: 1, source });

    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'skill_created', resource: 'skill', resourceId: skill.id, metadata: { name, sourceType: source.type }, traceId: c.get('traceId') ?? '' }).catch(() => {});

    return c.json({ data: { skill, version: versionRow } }, 202);
  } catch (err) {
    console.error('Failed to create skill:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// POST /skills/:id — import a new version of an existing (owned) skill
skillsRoutes.post('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  const result = z.object({ source: sourceSchema }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

  const source = result.data.source;
  if (source.type === 'zip' && !isOwnUploadKey(source.fileKey, tenantId)) {
    return c.json({ error: 'fileKey does not belong to this tenant', code: 'VALIDATION_ERROR' }, 400);
  }

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    if (skill.ownerTenantId !== tenantId) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const [maxRow] = await db.select({ v: skillVersions.version }).from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)).limit(1);
    const nextVersion = (maxRow?.v ?? 0) + 1;

    const versionRow = await createVersionAndEnqueue({ tenantId, skillId, version: nextVersion, source });
    return c.json({ data: { version: versionRow } }, 202);
  } catch (err) {
    console.error('Failed to create skill version:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// GET /skills/:id/versions
skillsRoutes.get('/:id/versions', async (c) => {
  const permissions = (c.get('requestContext') as any)?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const tenantId = (c.get('requestContext') as any)?.tenant?.id;
  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    const isOwner = skill.ownerTenantId === tenantId;
    if (!isOwner && skill.visibility !== 'public' && !skill.isOfficial) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const rows = await db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version));

    // Non-owners reach this route through the public/official escape hatches.
    // sourceRef carries the owner's raw S3 upload key (or private import URL),
    // s3Prefix the package location, and failureReason the owner's own import
    // diagnostics — none of which another tenant has any business reading.
    if (!isOwner) {
      const safe = rows.map((r) => {
        const { sourceRef: _sourceRef, s3Prefix: _s3Prefix, failureReason: _failureReason, ...rest } = r as Record<string, unknown>;
        return rest;
      });
      return c.json({ data: safe });
    }

    return c.json({ data: rows });
  } catch (err) {
    console.error('Failed to list skill versions:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// POST /skills/:id/publish — owner flips visibility to public, self-serve
skillsRoutes.post('/:id/publish', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  const userId = c.get('userId') as string;
  if (!hasPermission(permissions, 'skills', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    if (skill.ownerTenantId !== tenantId) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    // latestVersion only moves once a version reaches 'ready', so 0 here means
    // nothing installable exists — publishing would put a permanently unusable
    // card in every other tenant's Public tab.
    if (skill.latestVersion < 1) {
      return c.json({ error: 'Skill has no ready version to publish', code: 'NOT_READY' }, 409);
    }

    const [updated] = await db.update(skills).set({ visibility: 'public', updatedAt: new Date() }).where(eq(skills.id, skillId)).returning();

    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'skill_published', resource: 'skill', resourceId: skillId, metadata: {}, traceId: c.get('traceId') ?? '' }).catch(() => {});
    return c.json({ data: updated });
  } catch (err) {
    console.error('Failed to publish skill:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// POST /skills/:id/install — pinned to the current latestVersion; upserts so
// a previously-uninstalled row reactivates instead of violating the
// (tenantId, skillId) unique constraint
skillsRoutes.post('/:id/install', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  const userId = c.get('userId') as string;
  if (!hasPermission(permissions, 'skills', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    if (skill.ownerTenantId !== tenantId && skill.visibility !== 'public' && !skill.isOfficial) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (skill.latestVersion < 1) {
      return c.json({ error: 'Skill has no ready version yet', code: 'NOT_READY' }, 409);
    }

    const [installed] = await db.insert(skillInstalls).values({
      tenantId, skillId, installedVersion: skill.latestVersion, autoUpdate: false, status: 'active',
    }).onConflictDoUpdate({
      target: [skillInstalls.tenantId, skillInstalls.skillId],
      set: { status: 'active', installedVersion: skill.latestVersion, updatedAt: new Date() },
    }).returning();

    // Raw SQL, not db.update(skills): the Drizzle column has $onUpdate on
    // updatedAt, so an ORM update would bump the skill's "Last update"
    // timestamp on every install. Fire-and-forget — a counter must never fail
    // the install itself.
    db.execute(sql`UPDATE skills SET download_count = download_count + 1 WHERE id = ${skillId}`)
      .catch((err: unknown) => console.error('Failed to increment skill download_count:', err));

    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'skill_installed', resource: 'skill_install', resourceId: installed.id, metadata: { skillId, version: skill.latestVersion }, traceId: c.get('traceId') ?? '' }).catch(() => {});
    return c.json({ data: installed }, 201);
  } catch (err) {
    console.error('Failed to install skill:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// POST /skills/:id/install/update — explicit pin bump to the current
// latestVersion. autoUpdate is stored but not acted on by anything yet —
// this is the only way an install's version moves in this pass.
skillsRoutes.post('/:id/install/update', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    // The UPDATE below is already scoped to this tenant's own install row, so
    // this check changes no outcome today — it's here so every route that
    // references a skill applies the same owner/public/official rule.
    if (skill.ownerTenantId !== tenantId && skill.visibility !== 'public' && !skill.isOfficial) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const [updated] = await db.update(skillInstalls)
      .set({ installedVersion: skill.latestVersion, updatedAt: new Date() })
      .where(and(eq(skillInstalls.tenantId, tenantId), eq(skillInstalls.skillId, skillId), eq(skillInstalls.status, 'active')))
      .returning();

    if (!updated) return c.json({ error: 'Skill is not installed', code: 'NOT_FOUND' }, 404);
    return c.json({ data: updated });
  } catch (err) {
    console.error('Failed to update skill install:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});

// DELETE /skills/:id/install — soft uninstall
skillsRoutes.delete('/:id/install', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill is not installed', code: 'NOT_FOUND' }, 404);

  try {
    const [updated] = await db.update(skillInstalls)
      .set({ status: 'uninstalled', updatedAt: new Date() })
      .where(and(eq(skillInstalls.tenantId, tenantId), eq(skillInstalls.skillId, skillId)))
      .returning();

    if (!updated) return c.json({ error: 'Skill is not installed', code: 'NOT_FOUND' }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to uninstall skill:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});
