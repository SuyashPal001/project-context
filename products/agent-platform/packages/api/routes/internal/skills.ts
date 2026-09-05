import { Hono } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission, resolveUserPermissions } from '@serverless-saas/permissions';
import { IdempotencyStore } from '@serverless-saas/idempotency';
import { getCacheClient } from '@serverless-saas/cache';
import { isAuthorized } from './tasks.auth';
import { slugify, createVersionAndEnqueue } from '../skills';
import type { AppEnv } from '@serverless-saas/types';

export const internalSkillsRoute = new Hono<AppEnv>();

/** Chat makes skill creation cheap; nothing else bounds it. There is no
 *  `skills` entitlement in the features seed, so this is the only ceiling. */
const DAILY_TENANT_LIMIT = 20;

const schema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  body: z.string().min(1).max(65_536),
});

// Creating a skill from inside a conversation. The service key authenticates
// the *orchestrator*, never the person on the other end of the chat — so the
// acting user's own permissions are resolved and enforced here. Without that, a
// viewer-role user who cannot create a skill in the dashboard could create one
// by asking an agent to.
internalSkillsRoute.post('/', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  const { tenantId, userId, agentId, conversationId, messageId, name, description, body } = parsed.data;

  const permissions = await resolveUserPermissions(db, tenantId, userId);
  if (!permissions || !hasPermission(permissions, 'skills', 'create')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const store = new IdempotencyStore(getCacheClient());
  const idempotencyKey = `skill-create:${conversationId}:${messageId}:${slugify(name)}`;
  let claimed = false;

  try {
    // Scoped to authored (chat-created) skills only: skill_versions.source_type
    // is the only place origin is recorded (skills has no origin column), so a
    // tenant that imports 20 skills from the dashboard must not be locked out
    // of chat creation, and vice versa — they are unrelated ceilings.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skills)
      .innerJoin(skillVersions, and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, 1)))
      .where(and(
        eq(skills.ownerTenantId, tenantId),
        eq(skillVersions.sourceType, 'authored'),
        gte(skills.createdAt, since),
      ));
    if (count >= DAILY_TENANT_LIMIT) {
      return c.json({ error: `Daily limit of ${DAILY_TENANT_LIMIT} created skills reached.`, code: 'QUOTA_EXCEEDED' }, 429);
    }

    // A retried tool call must not create a second skill. Slugs carry a random
    // suffix, so the (ownerTenantId, slug) unique constraint never catches this.
    claimed = await store.acquire(idempotencyKey);
    if (!claimed) {
      return c.json({ error: 'This skill was already created for that message.', code: 'DUPLICATE_REQUEST' }, 409);
    }

    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
    const [skill] = await db.insert(skills).values({
      ownerTenantId: tenantId, name, slug, description: description ?? null,
      visibility: 'private', isOfficial: false, latestVersion: 0, createdBy: userId,
    }).returning();

    await createVersionAndEnqueue({
      tenantId, skillId: skill.id, version: 1,
      source: { type: 'authored', body },
      attachToAgentId: agentId,
    });

    // Installed here rather than by a second user action: a skill created
    // mid-conversation is meant to be in use, and the worker's attach step
    // needs an install row to point agent_skills.install_id at.
    const [install] = await db.insert(skillInstalls).values({
      tenantId, skillId: skill.id, installedVersion: 1, status: 'active',
    }).returning();

    db.insert(auditLog).values({
      tenantId, actorId: userId, actorType: 'human', action: 'skill_created',
      resource: 'skill', resourceId: skill.id,
      metadata: { name, sourceType: 'authored', origin: 'conversation', conversationId, agentId },
      traceId: c.get('traceId') ?? '',
    }).catch(() => {});

    // Durably mark this message done so a post-TTL redelivery still can't
    // create a second skill once the 15-minute processing claim has expired.
    await store.complete(idempotencyKey);

    return c.json({ data: { skillId: skill.id, installId: install.id } }, 202);
  } catch (err) {
    console.error('Failed to create skill from conversation:', err);
    // Release the claim so a retry of the same message isn't stuck behind a
    // 15-minute idempotency window with no skill to show for it.
    if (claimed) await store.release(idempotencyKey).catch(() => {});
    return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});
