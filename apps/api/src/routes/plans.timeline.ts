import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { projectPlans, projectMilestones } from '@serverless-saas/database/schema/pm';
import { agentTasks, taskDependencies } from '@serverless-saas/database/schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

// GET /:planId/timeline
export async function handlePlanTimeline(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { planId } = c.req.param();

    // Round trip 1: verify plan exists and belongs to tenant
    const plan = (await db
        .select({
            id: projectPlans.id,
            title: projectPlans.title,
            startDate: projectPlans.startDate,
            targetDate: projectPlans.targetDate,
            status: projectPlans.status,
        })
        .from(projectPlans)
        .where(and(
            eq(projectPlans.id, planId),
            eq(projectPlans.tenantId, tenantId),
            isNull(projectPlans.deletedAt),
        ))
        .limit(1))[0];

    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    // Round trip 2 (parallel): milestones with per-row count subqueries + tasks with step counts
    const [milestones, tasks] = await Promise.all([
        db.select({
            id:           projectMilestones.id,
            title:        projectMilestones.title,
            startDate:    projectMilestones.startDate,
            targetDate:   projectMilestones.targetDate,
            completedAt:  projectMilestones.completedAt,
            status:       projectMilestones.status,
            priority:     projectMilestones.priority,
            assigneeId:   projectMilestones.assigneeId,
            taskCount: sql<number>`(
                SELECT COUNT(*)::int FROM agent_tasks
                WHERE milestone_id = ${projectMilestones.id}
                AND tenant_id = ${tenantId}::uuid
            )`,
            completedTaskCount: sql<number>`(
                SELECT COUNT(*)::int FROM agent_tasks
                WHERE milestone_id = ${projectMilestones.id}
                AND tenant_id = ${tenantId}::uuid
                AND status = 'done'
            )`,
        })
        .from(projectMilestones)
        .where(and(
            eq(projectMilestones.planId, planId),
            isNull(projectMilestones.deletedAt),
        ))
        .orderBy(projectMilestones.sequenceId),

        db.select({
            id:             agentTasks.id,
            title:          agentTasks.title,
            milestoneId:    agentTasks.milestoneId,
            parentTaskId:   agentTasks.parentTaskId,
            assigneeId:     agentTasks.assigneeId,
            status:         agentTasks.status,
            priority:       agentTasks.priority,
            startDate:      agentTasks.startDate,
            dueDate:        agentTasks.dueDate,
            startedAt:      agentTasks.startedAt,
            completedAt:    agentTasks.completedAt,
            estimatedHours: agentTasks.estimatedHours,
            totalSteps: sql<number>`(
                SELECT COUNT(*)::int FROM task_steps
                WHERE task_id = ${agentTasks.id}
            )`,
            completedSteps: sql<number>`(
                SELECT COUNT(*)::int FROM task_steps
                WHERE task_id = ${agentTasks.id}
                AND status = 'done'
            )`,
        })
        .from(agentTasks)
        .where(and(
            eq(agentTasks.planId, planId),
            eq(agentTasks.tenantId, tenantId),
        ))
        .orderBy(agentTasks.sortOrder),
    ]);

    // Round trip 3: all dependencies internal to this plan's tasks (skip if no tasks)
    const taskIds = tasks.map((t) => t.id);
    type DepRow = { id: string; fromTaskId: string; toTaskId: string; relationType: string };
    let allDeps: DepRow[] = [];

    if (taskIds.length > 0) {
        allDeps = await db
            .select({
                id:           taskDependencies.id,
                fromTaskId:   taskDependencies.fromTaskId,
                toTaskId:     taskDependencies.toTaskId,
                relationType: taskDependencies.relationType,
            })
            .from(taskDependencies)
            .where(and(
                eq(taskDependencies.tenantId, tenantId),
                isNull(taskDependencies.deletedAt),
                inArray(taskDependencies.fromTaskId, taskIds),
                inArray(taskDependencies.toTaskId, taskIds),
            ));
    }

    // Attach dependencies to tasks in app code — O(n) map, no extra DB queries
    const depsByTask = new Map<string, DepRow[]>();
    for (const dep of allDeps) {
        if (!depsByTask.has(dep.fromTaskId)) depsByTask.set(dep.fromTaskId, []);
        depsByTask.get(dep.fromTaskId)!.push(dep);
    }

    return c.json({
        data: {
            plan,
            milestones,
            tasks: tasks.map((t) => ({ ...t, dependencies: depsByTask.get(t.id) ?? [] })),
        },
    });
}
