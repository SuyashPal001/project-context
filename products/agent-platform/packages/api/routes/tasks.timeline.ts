import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentTasks, taskEvents } from '@serverless-saas/agent-schema/agents';
import { taskRevisions } from '@serverless-saas/agent-schema/task-revisions';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { mergeTimeline } from '../lib/timeline';
import type { TimelineRevision } from '../lib/timeline';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// GET /tasks/:taskId/timeline — provenance feed for one task.
// Merges server-side and returns finished rows: apps/web is HTTP-only (no
// workspace dependencies), so keeping the ordering logic here means it exists
// and is tested in exactly one place.
export async function handleGetTimeline(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const taskId = c.req.param('taskId') as string;

    const task = (await db.select({
        id: agentTasks.id,
        rawInput: agentTasks.rawInput,
        createdAt: sql<string>`to_char(${agentTasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    }).from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const revisionRows = await db.select({
        id: taskRevisions.id,
        field: taskRevisions.field,
        originalContent: taskRevisions.originalContent,
        correctedContent: taskRevisions.correctedContent,
        actorType: taskRevisions.actorType,
        actorName: users.name,
        createdAt: taskRevisions.createdAt,
    })
        .from(taskRevisions)
        .leftJoin(users, eq(taskRevisions.actorId, users.id))
        .where(and(
            eq(taskRevisions.taskId, taskId),
            eq(taskRevisions.tenantId, tenantId),
        ))
        .orderBy(asc(taskRevisions.createdAt));

    const eventRows = await db.select({
        id: taskEvents.id,
        eventType: taskEvents.eventType,
        actorType: taskEvents.actorType,
        payload: taskEvents.payload,
        createdAt: sql<string>`to_char(${taskEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
        .from(taskEvents)
        .where(and(
            eq(taskEvents.taskId, taskId),
            eq(taskEvents.tenantId, tenantId),
        ))
        .orderBy(asc(taskEvents.createdAt));

    const rows = mergeTimeline({
        rawInput: task.rawInput,
        originAt: task.createdAt,
        // agent_tasks.created_at and task_events.created_at are naive `timestamp`
        // while task_revisions.created_at is `timestamptz`. The two naive columns
        // are emitted as UTC ISO-8601 strings directly from SQL (see selects above)
        // so ordering stays correct regardless of the process timezone.
        revisions: revisionRows.map(r => ({
            id: r.id,
            field: r.field as TimelineRevision['field'],
            originalContent: r.originalContent,
            correctedContent: r.correctedContent,
            actorType: r.actorType,
            actorName: r.actorName ?? undefined,
            createdAt: r.createdAt.toISOString(),
        })),
        events: eventRows.map(e => ({
            id: e.id,
            eventType: e.eventType,
            actorType: e.actorType,
            payload: (e.payload ?? undefined) as Record<string, unknown> | undefined,
            createdAt: e.createdAt,
        })),
    });

    return c.json({ data: rows });
}
