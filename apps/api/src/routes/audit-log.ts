import { Hono } from 'hono';
import { and, eq, ilike, gte, lte, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, auditLog } from '@serverless-saas/database';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { verifyAuditChain } from '../services/audit-log.js';
import type { AppEnv } from '../types';

export const auditLogRoutes = new Hono<AppEnv>();

const querySchema = z.object({
    page:      z.coerce.number().int().min(1).default(1),
    pageSize:  z.coerce.number().int().min(1).max(100).default(20),
    actorType: z.enum(['human', 'agent', 'system']).optional(),
    action:    z.string().optional(),
    dateFrom:  z.string().datetime().optional(),
    dateTo:    z.string().datetime().optional(),
});

// GET /audit-log — paginated, filtered audit entries for tenant
auditLogRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'audit_log', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const { page, pageSize, actorType, action, dateFrom, dateTo } = parsed.data;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(auditLog.tenantId, tenantId)];
    if (actorType) conditions.push(eq(auditLog.actorType, actorType));
    if (action)    conditions.push(ilike(auditLog.action, `%${action}%`));
    if (dateFrom)  conditions.push(gte(auditLog.createdAt, new Date(dateFrom)));
    if (dateTo)    conditions.push(lte(auditLog.createdAt, new Date(dateTo)));
    const where = and(...conditions);

    const [entries, countResult] = await Promise.all([
        db.select().from(auditLog).where(where)
            .orderBy(desc(auditLog.createdAt)).limit(pageSize).offset(offset),
        db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where),
    ]);

    return c.json({ data: { entries, total: countResult[0]?.total ?? 0, page, pageSize } });
});

// GET /audit-log/summary — accountability summary for the configured period
auditLogRoutes.get('/summary', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'audit_log', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);
    const base = and(eq(auditLog.tenantId, tenantId), gte(auditLog.createdAt, since));

    const [byActor, approvalRows, guardrailRows, approverRows, agentActionRows] = await Promise.all([
        db.select({ actorType: auditLog.actorType, count: sql<number>`count(*)::int` })
            .from(auditLog).where(base).groupBy(auditLog.actorType),

        db.select({ action: auditLog.action, count: sql<number>`count(*)::int` })
            .from(auditLog)
            .where(and(base, sql`${auditLog.action} IN ('task_plan_approved','task_plan_rejected')`))
            .groupBy(auditLog.action),

        db.select({ count: sql<number>`count(*)::int` })
            .from(auditLog)
            .where(and(base, eq(auditLog.action, 'guardrail_violation'))),

        db.select({ actorId: auditLog.actorId, name: users.name, approvals: sql<number>`count(*)::int` })
            .from(auditLog)
            .leftJoin(users, eq(auditLog.actorId, users.id))
            .where(and(base, eq(auditLog.action, 'task_plan_approved'), eq(auditLog.actorType, 'human')))
            .groupBy(auditLog.actorId, users.name)
            .orderBy(desc(sql`count(*)`))
            .limit(5),

        db.select({ action: auditLog.action, count: sql<number>`count(*)::int` })
            .from(auditLog)
            .where(and(base, eq(auditLog.actorType, 'agent')))
            .groupBy(auditLog.action)
            .orderBy(desc(sql`count(*)`))
            .limit(10),
    ]);

    const totals: Record<string, number> = { human: 0, agent: 0, system: 0, total: 0 };
    for (const row of byActor) { totals[row.actorType] = row.count; totals.total += row.count; }

    const approved = approvalRows.find((r: { action: string }) => r.action === 'task_plan_approved')?.count ?? 0;
    const rejected = approvalRows.find((r: { action: string }) => r.action === 'task_plan_rejected')?.count ?? 0;
    const approvalTotal = approved + rejected;

    return c.json({ data: {
        period: { days, from: since.toISOString(), to: new Date().toISOString() },
        totals,
        approvals: { approved, rejected, rate: approvalTotal > 0 ? Math.round((approved / approvalTotal) * 100) / 100 : null },
        guardrailViolations: guardrailRows[0]?.count ?? 0,
        topApprovers: approverRows.map((r: { actorId: string; name: string | null; approvals: number }) => ({ actorId: r.actorId, name: r.name ?? r.actorId, approvals: r.approvals })),
        topAgentActions: agentActionRows.map((r: { action: string; count: number }) => ({ action: r.action, count: r.count })),
    }});
});

// GET /audit-log/verify — verify SHA-256 hash chain integrity for tenant
auditLogRoutes.get('/verify', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'audit_log', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const result = await verifyAuditChain(tenantId);
    return c.json({ data: result });
});

// GET /audit-log/export — CSV export (max 10,000 rows)
auditLogRoutes.get('/export', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'audit_log', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { actorType, action, dateFrom, dateTo } = querySchema.parse(c.req.query());

    const conditions = [eq(auditLog.tenantId, tenantId)];
    if (actorType) conditions.push(eq(auditLog.actorType, actorType));
    if (action)    conditions.push(ilike(auditLog.action, `%${action}%`));
    if (dateFrom)  conditions.push(gte(auditLog.createdAt, new Date(dateFrom)));
    if (dateTo)    conditions.push(lte(auditLog.createdAt, new Date(dateTo)));

    const entries = await db.select().from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(10_000);

    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = 'id,timestamp,actor_type,actor_id,action,resource,resource_id,metadata,trace_id'
    const rows = entries.map((e: typeof entries[number]) => [
        esc(e.id), esc(e.createdAt.toISOString()), esc(e.actorType), esc(e.actorId),
        esc(e.action), esc(e.resource), esc(e.resourceId), esc(JSON.stringify(e.metadata ?? {})), esc(e.traceId),
    ].join(','))

    const date = new Date().toISOString().slice(0, 10)
    return new Response([header, ...rows].join('\n'), {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="audit-log-${date}.csv"`,
        },
    });
});
