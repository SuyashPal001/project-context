import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { skills } from '@serverless-saas/agent-schema/skills';
import { isPlatformAdmin } from './ops.guard';
import { getLogger } from '@serverless-saas/logger';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const logger = getLogger({ serviceName: 'ops-api' });

// PATCH /ops/skills/:id — admin-only Official flag, no review workflow
export async function handlePatchSkillOfficial(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const id = c.req.param('id') as string;
  const traceId = c.get('traceId') ?? 'unknown';
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Skill not found' }, 404);

  const result = z.object({ isOfficial: z.boolean() }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

  try {
    const [updated] = await db.update(skills)
      .set({ isOfficial: result.data.isOfficial, updatedAt: new Date() })
      .where(eq(skills.id, id))
      .returning();

    if (!updated) return c.json({ error: 'Skill not found' }, 404);

    // Official is a platform-wide trust signal — every flip needs an actor on
    // record, same as the provider status toggle next door.
    logger.info('ops_skill_official_changed', { traceId, skillId: id, isOfficial: result.data.isOfficial, actorId: c.get('userId') });
    return c.json({ data: updated });
  } catch (err) {
    logger.error('ops_patch_skill_failed', { traceId, skillId: id, error: err as Error });
    return c.json({ error: 'Failed to update skill', code: 'QUERY_ERROR' }, 500);
  }
}
