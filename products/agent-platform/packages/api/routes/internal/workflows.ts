import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentWorkflowRuns } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import type { AppEnv } from '@serverless-saas/types';

function isAuthorized(provided: string): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY
  if (!expected) return false
  try {
    return timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(expected)
    )
  } catch {
    return false
  }
}

const updateSchema = z.object({
  tenantId: z.string().uuid().optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  stepsCompleted: z.array(z.unknown()).optional(),
  toolsCalled: z.array(z.unknown()).optional(),
  insights: z.string().optional(),
  completedAt: z.string().optional(),
});

export const internalWorkflowsRoute = new Hono<AppEnv>();

internalWorkflowsRoute.post('/:workflowRunId/update', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { workflowRunId } = c.req.param();
  const body = await c.req.json().catch(() => null);

  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const update: Partial<typeof agentWorkflowRuns.$inferInsert> = {};

  if (parsed.data.status !== undefined) {
    update.status = parsed.data.status;
  }
  if (parsed.data.stepsCompleted !== undefined) {
    update.stepsCompleted = parsed.data.stepsCompleted;
  }
  if (parsed.data.toolsCalled !== undefined) {
    update.toolsCalled = parsed.data.toolsCalled;
  }
  if (parsed.data.insights !== undefined) {
    update.insights = parsed.data.insights;
  }
  if (parsed.data.completedAt !== undefined) {
    update.completedAt = new Date(parsed.data.completedAt);
  }

  if (Object.keys(update).length === 0) {
    return c.json({ success: true });
  }

  await db
    .update(agentWorkflowRuns)
    .set(update)
    .where(eq(agentWorkflowRuns.id, workflowRunId));

  if (parsed.data.tenantId && parsed.data.status) {
    db.insert(auditLog).values({
      tenantId: parsed.data.tenantId, actorId: 'system', actorType: 'system',
      action: 'workflow_run_updated', resource: 'agent_workflow_run', resourceId: workflowRunId,
      metadata: { status: parsed.data.status }, traceId: c.req.header('x-trace-id') ?? '',
    }).catch((err: unknown) => console.error('Audit log write failed:', err));
  }

  return c.json({ success: true });
});
