import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { projectPlans } from '@serverless-saas/agent-schema/pm';
import { hasPermission } from '@serverless-saas/permissions';
import { nextSequenceId } from '../lib/sequence';
import type { AppEnv } from '@serverless-saas/types';
import { handlePlanSummary, handleListMilestones, handleCreateMilestone, handlePlanTasks } from './plans.milestones';
import { handlePlanTimeline } from './plans.timeline';

export const plansRoutes = new Hono<AppEnv>();

export const VALID_PLAN_TRANSITIONS: Record<string, string[]> = {
    draft:     ['active', 'archived'],
    active:    ['completed', 'archived'],
    completed: [],
    archived:  [],
};

// POST /plans
plansRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({ title: z.string().min(1).max(200), description: z.string().optional(), startDate: z.string().datetime().optional(), targetDate: z.string().datetime().optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { title, description, startDate, targetDate } = result.data;
    const sequenceId = await nextSequenceId(tenantId, 'plan');
    const [plan] = await db.insert(projectPlans).values({ tenantId, sequenceId, title, description: description ?? null, status: 'draft', startDate: startDate ? new Date(startDate) : null, targetDate: targetDate ? new Date(targetDate) : null, createdBy: userId }).returning();

    return c.json({ data: plan }, 201);
});

// GET /plans
plansRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const plans = await db.select().from(projectPlans).where(and(eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).orderBy(projectPlans.sequenceId);
    return c.json({ data: plans });
});

// GET /plans/:planId
plansRoutes.get('/:planId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const plan = (await db.select().from(projectPlans).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).limit(1))[0];
    if (!plan) return c.json({ error: 'Plan not found' }, 404);
    return c.json({ data: plan });
});

// PATCH /plans/:planId
plansRoutes.patch('/:planId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const result = z.object({ title: z.string().min(1).max(200).optional(), description: z.string().nullable().optional(), status: z.enum(['draft', 'active', 'completed', 'archived']).optional(), startDate: z.string().datetime().nullable().optional(), targetDate: z.string().datetime().nullable().optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const plan = (await db.select().from(projectPlans).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).limit(1))[0];
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const { title, description, status, startDate, targetDate } = result.data;
    if (status !== undefined && status !== plan.status) {
        const allowed = VALID_PLAN_TRANSITIONS[plan.status] ?? [];
        if (!allowed.includes(status)) return c.json({ error: `Cannot transition plan from ${plan.status} to ${status}` }, 400);
    }

    const updates: Partial<typeof projectPlans.$inferInsert> = { updatedAt: new Date() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (startDate !== undefined) updates.startDate = startDate ? new Date(startDate) : null;
    if (targetDate !== undefined) updates.targetDate = targetDate ? new Date(targetDate) : null;

    const [updated] = await db.update(projectPlans).set(updates).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId))).returning();
    return c.json({ data: updated });
});

// DELETE /plans/:planId
plansRoutes.delete('/:planId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const [updated] = await db.update(projectPlans).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).returning({ id: projectPlans.id });
    if (!updated) return c.json({ error: 'Plan not found' }, 404);
    return c.json({ success: true });
});

// PATCH /plans/:planId/approve — transition draft → active (Canvas "Approve Roadmap" button)
plansRoutes.patch('/:planId/approve', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const [updated] = await db.update(projectPlans).set({ status: 'active', updatedAt: new Date() }).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).returning({ id: projectPlans.id, status: projectPlans.status });
    if (!updated) return c.json({ error: 'Plan not found' }, 404);
    return c.json({ data: updated });
});

// Plan detail routes
plansRoutes.get('/:planId/summary', handlePlanSummary);
plansRoutes.get('/:planId/milestones', handleListMilestones);
plansRoutes.post('/:planId/milestones', handleCreateMilestone);
plansRoutes.get('/:planId/tasks', handlePlanTasks);
plansRoutes.get('/:planId/timeline', handlePlanTimeline);
