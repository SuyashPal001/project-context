import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { projectMilestones } from '@serverless-saas/agent-schema/pm';
import { agentTasks } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const milestonesRoutes = new Hono<AppEnv>();

export const VALID_MILESTONE_TRANSITIONS: Record<string, string[]> = {
    backlog:     ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
};

// ─── GET /:milestoneId/tasks — tasks for a milestone ─────────────────────────

milestonesRoutes.get('/:milestoneId/tasks', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { milestoneId } = c.req.param();

    // Verify milestone belongs to tenant
    const milestone = (await db
        .select({ id: projectMilestones.id })
        .from(projectMilestones)
        .where(and(
            eq(projectMilestones.id, milestoneId),
            eq(projectMilestones.tenantId, tenantId),
            isNull(projectMilestones.deletedAt),
        ))
        .limit(1))[0];

    if (!milestone) return c.json({ error: 'Milestone not found' }, 404);

    const tasks = await db
        .select()
        .from(agentTasks)
        .where(and(
            eq(agentTasks.milestoneId, milestoneId),
            eq(agentTasks.tenantId, tenantId),
        ))
        .orderBy(agentTasks.sortOrder);

    return c.json({ data: tasks });
});

// ─── PATCH /:milestoneId — update milestone ───────────────────────────────────

milestonesRoutes.patch('/:milestoneId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_milestones', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { milestoneId } = c.req.param();

    const schema = z.object({
        title:               z.string().min(1).max(200).optional(),
        description:         z.string().nullable().optional(),
        status:              z.enum(['backlog', 'in_progress', 'completed', 'cancelled']).optional(),
        targetDate:          z.string().datetime().nullable().optional(),
        assigneeId:          z.string().uuid().nullable().optional(),
        priority:            z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        acceptanceCriteria:  z.array(z.string()).optional(),
        estimatedHours:      z.number().nullable().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: result.error.errors[0].message }, 400);
    }

    const milestone = (await db.select().from(projectMilestones).where(and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.tenantId, tenantId),
        isNull(projectMilestones.deletedAt),
    )).limit(1))[0];

    if (!milestone) return c.json({ error: 'Milestone not found' }, 404);

    const { title, description, status, targetDate, assigneeId, priority, acceptanceCriteria, estimatedHours } = result.data;

    if (status !== undefined && status !== milestone.status) {
        const allowed = VALID_MILESTONE_TRANSITIONS[milestone.status] ?? [];
        if (!allowed.includes(status)) {
            return c.json({ error: `Cannot transition milestone from ${milestone.status} to ${status}` }, 400);
        }
    }

    const updates: Partial<typeof projectMilestones.$inferInsert> = { updatedAt: new Date() };
    if (title               !== undefined) updates.title               = title;
    if (description         !== undefined) updates.description         = description;
    if (status              !== undefined) {
        updates.status = status;
        if (status === 'completed') updates.completedAt = new Date();
    }
    if (targetDate          !== undefined) updates.targetDate          = targetDate ? new Date(targetDate) : null;
    if (assigneeId          !== undefined) updates.assigneeId          = assigneeId;
    if (priority            !== undefined) updates.priority            = priority;
    if (acceptanceCriteria  !== undefined) updates.acceptanceCriteria  = acceptanceCriteria as any;
    if (estimatedHours      !== undefined) updates.estimatedHours      = estimatedHours != null ? String(estimatedHours) : null;

    const [updated] = await db
        .update(projectMilestones)
        .set(updates)
        .where(and(
            eq(projectMilestones.id, milestoneId),
            eq(projectMilestones.tenantId, tenantId),
        ))
        .returning();

    return c.json({ data: updated });
});

// ─── DELETE /:milestoneId — soft delete ──────────────────────────────────────

milestonesRoutes.delete('/:milestoneId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_milestones', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { milestoneId } = c.req.param();

    const [updated] = await db
        .update(projectMilestones)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(
            eq(projectMilestones.id, milestoneId),
            eq(projectMilestones.tenantId, tenantId),
            isNull(projectMilestones.deletedAt),
        ))
        .returning({ id: projectMilestones.id });

    if (!updated) return c.json({ error: 'Milestone not found' }, 404);

    return c.json({ success: true });
});
