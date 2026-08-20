import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../db';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
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

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
}

async function resolveSkill(skillId: string) {
  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  return skill ?? null;
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

// GET /skills?tab=mine|official|public
skillsRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const tab = (c.req.query('tab') ?? 'mine') as 'mine' | 'official' | 'public';
  const filter = tab === 'official' ? eq(skills.isOfficial, true)
    : tab === 'public' ? eq(skills.visibility, 'public')
    : eq(skills.ownerTenantId, tenantId);

  const rows = await db
    .select({
      id: skills.id, name: skills.name, slug: skills.slug, description: skills.description,
      visibility: skills.visibility, isOfficial: skills.isOfficial, latestVersion: skills.latestVersion,
      ownerTenantId: skills.ownerTenantId, createdAt: skills.createdAt,
      installedVersion: skillInstalls.installedVersion, installStatus: skillInstalls.status,
    })
    .from(skills)
    .leftJoin(skillInstalls, and(eq(skillInstalls.skillId, skills.id), eq(skillInstalls.tenantId, tenantId)))
    .where(filter)
    .orderBy(desc(skills.createdAt));

  return c.json({ data: rows.map((r) => ({ ...r, installed: r.installStatus === 'active' })) });
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
  const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;

  const [skill] = await db.insert(skills).values({
    ownerTenantId: tenantId, name, slug, description: description ?? null,
    visibility: 'private', isOfficial: false, latestVersion: 0, createdBy: userId,
  }).returning();

  const versionRow = await createVersionAndEnqueue({ tenantId, skillId: skill.id, version: 1, source });

  db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'skill_created', resource: 'skill', resourceId: skill.id, metadata: { name, sourceType: source.type }, traceId: c.get('traceId') ?? '' }).catch(() => {});

  return c.json({ data: { skill, version: versionRow } }, 202);
});

// POST /skills/:id — import a new version of an existing (owned) skill
skillsRoutes.post('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  const skill = await resolveSkill(skillId);
  if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
  if (skill.ownerTenantId !== tenantId) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const result = z.object({ source: sourceSchema }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

  const [maxRow] = await db.select({ v: skillVersions.version }).from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)).limit(1);
  const nextVersion = (maxRow?.v ?? 0) + 1;

  const versionRow = await createVersionAndEnqueue({ tenantId, skillId, version: nextVersion, source: result.data.source });
  return c.json({ data: { version: versionRow } }, 202);
});

// GET /skills/:id/versions
skillsRoutes.get('/:id/versions', async (c) => {
  const permissions = (c.get('requestContext') as any)?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const tenantId = (c.get('requestContext') as any)?.tenant?.id;
  const skillId = c.req.param('id');
  const skill = await resolveSkill(skillId);
  if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
  if (skill.ownerTenantId !== tenantId && skill.visibility !== 'public' && !skill.isOfficial) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const data = await db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version));
  return c.json({ data });
});
