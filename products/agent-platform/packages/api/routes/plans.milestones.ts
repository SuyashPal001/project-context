import { z } from 'zod';
import { eq, and, isNull, count, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import { projectPlans, projectMilestones, type ProjectMilestone } from '@serverless-saas/agent-schema/pm';
import { agentTasks } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import { nextSequenceId } from '../lib/sequence';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const loadPlan = async (planId: string, tenantId: string) =>
    (await db.select({ id: projectPlans.id }).from(projectPlans).where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt))).limit(1))[0];

// GET /:planId/summary
export async function handlePlanSummary(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const plan = await loadPlan(planId, tenantId);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const [[milestoneCounts], [taskCounts]] = await Promise.all([
        db.select({ total: count(), completed: sql<number>`count(*) filter (where ${projectMilestones.status} = 'completed')` }).from(projectMilestones).where(and(eq(projectMilestones.planId, planId), isNull(projectMilestones.deletedAt))),
        db.select({ total: count(), completed: sql<number>`count(*) filter (where ${agentTasks.status} = 'done')` }).from(agentTasks).where(and(eq(agentTasks.planId, planId), eq(agentTasks.tenantId, tenantId))),
    ]);

    return c.json({ data: { totalMilestones: Number(milestoneCounts.total), completedMilestones: Number(milestoneCounts.completed), totalTasks: Number(taskCounts.total), completedTasks: Number(taskCounts.completed) } });
}

// GET /:planId/milestones
export async function handleListMilestones(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_milestones', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const plan = await loadPlan(planId, tenantId);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    let milestones: ProjectMilestone[];
    try {
        milestones = await db.select().from(projectMilestones).where(and(eq(projectMilestones.planId, planId), isNull(projectMilestones.deletedAt))).orderBy(projectMilestones.sequenceId);
    } catch (err) {
        console.error('[handleListMilestones] db.select(projectMilestones) failed', { planId, tenantId, err });
        return c.json({ error: 'Internal server error', code: 'DB_ERROR' }, 500);
    }

    if (milestones.length === 0) return c.json({ data: [] });

    type CountRow = { milestoneId: string | null; total: number; completed: number };
    const milestoneIds = milestones.map((m) => m.id);
    let taskCounts: CountRow[];
    try {
        taskCounts = await db
            .select({ milestoneId: agentTasks.milestoneId, total: count(), completed: sql<number>`count(*) filter (where ${agentTasks.status} = 'done')` })
            .from(agentTasks).where(and(inArray(agentTasks.milestoneId, milestoneIds), eq(agentTasks.tenantId, tenantId))).groupBy(agentTasks.milestoneId);
    } catch (err) {
        console.error('[handleListMilestones] db.select(taskCounts) failed', { planId, tenantId, err });
        return c.json({ error: 'Internal server error', code: 'DB_ERROR' }, 500);
    }

    const countMap = new Map<string, CountRow>(taskCounts.filter((r): r is CountRow & { milestoneId: string } => r.milestoneId !== null).map((r) => [r.milestoneId, r]));

    return c.json({ data: milestones.map((m) => { const c2 = countMap.get(m.id); return { ...m, totalTasks: c2 ? Number(c2.total) : 0, completedTasks: c2 ? Number(c2.completed) : 0 }; }) });
}

// POST /:planId/milestones
export async function handleCreateMilestone(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_milestones', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const plan = await loadPlan(planId, tenantId);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const result = z.object({ title: z.string().min(1).max(200), description: z.string().optional(), targetDate: z.string().datetime().optional(), assigneeId: z.string().uuid().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { title, description, targetDate, assigneeId, priority } = result.data;
    const sequenceId = await nextSequenceId(tenantId, 'milestone');

    const [milestone] = await db.insert(projectMilestones).values({ tenantId, planId, sequenceId, title, description: description ?? null, status: 'backlog', targetDate: targetDate ? new Date(targetDate) : null, assigneeId: assigneeId ?? null, priority: priority ?? 'medium', createdBy: userId }).returning();

    return c.json({ data: milestone }, 201);
}

// GET /:planId/tasks
export async function handlePlanTasks(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { planId } = c.req.param();
    const floating = c.req.query('floating') === 'true';
    const plan = await loadPlan(planId, tenantId);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const tasks = await db.select().from(agentTasks).where(and(eq(agentTasks.planId, planId), eq(agentTasks.tenantId, tenantId), floating ? isNull(agentTasks.milestoneId) : undefined)).orderBy(agentTasks.sortOrder);

    return c.json({ data: tasks });
}
