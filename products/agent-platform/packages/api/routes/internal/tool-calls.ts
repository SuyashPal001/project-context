import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { toolCallLogs } from '@serverless-saas/agent-schema/intelligence';
import { users } from '@serverless-saas/database/schema/auth';
import type { AppEnv } from '@serverless-saas/types';

function isAuthorized(provided: string): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function resolveUserId(cognitoSubOrId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.cognitoId, cognitoSubOrId))
    .limit(1);
  return row?.id ?? null;
}

const internalToolCallsRoute = new Hono<AppEnv>();

// POST /internal/tool-calls/log — relay calls this after each tool invocation
internalToolCallsRoute.post('/log', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const schema = z.object({
    tenantId:       z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    taskId:         z.string().uuid().optional(),
    userId:         z.string().uuid().nullable().optional(),
    toolName:       z.string().min(1),
    success:        z.boolean(),
    latencyMs:      z.number().int().min(0).optional(),
    errorMessage:   z.string().optional(),
    args:           z.record(z.unknown()).optional(),
  });

  const result = schema.safeParse(await c.req.json());
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const d = result.data;

  // Resolve Cognito sub → internal users.id before inserting.
  // The GCP relay sends payload.sub (Cognito UUID); tool_call_logs.user_id
  // is a FK to users.id (internal Postgres UUID). Mismatched UUIDs cause a
  // silent FK violation. If the lookup fails, store null rather than failing.
  const resolvedUserId = d.userId ? await resolveUserId(d.userId) : null;

  try {
    await db.insert(toolCallLogs).values({
      tenantId:       d.tenantId,
      conversationId: d.conversationId ?? null,
      taskId:         d.taskId ?? null,
      userId:         resolvedUserId,
      toolName:       d.toolName,
      success:        d.success,
      latencyMs:      d.latencyMs ?? null,
      errorMessage:   d.errorMessage ?? null,
      args:           d.args ?? null,
    });
  } catch (err) {
    console.error('[internal/tool-calls/log] insert failed:', err);
  }

  return c.json({ success: true }, 200);
});

export default internalToolCallsRoute;
