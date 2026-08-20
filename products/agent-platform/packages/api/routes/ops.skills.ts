import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { skills } from '@serverless-saas/agent-schema/skills';
import { isPlatformAdmin } from './ops.guard';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// PATCH /ops/skills/:id — admin-only Official flag, no review workflow
export async function handlePatchSkillOfficial(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const id = c.req.param('id') as string;
  const result = z.object({ isOfficial: z.boolean() }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

  const [updated] = await db.update(skills)
    .set({ isOfficial: result.data.isOfficial, updatedAt: new Date() })
    .where(eq(skills.id, id))
    .returning();

  if (!updated) return c.json({ error: 'Skill not found' }, 404);
  return c.json({ data: updated });
}
