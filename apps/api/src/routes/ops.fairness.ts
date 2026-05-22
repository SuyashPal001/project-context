import { eq, sql, desc, and } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/database/schema/agents';
import { agentSkills } from '@serverless-saas/database/schema/conversations';
import { agentFairnessReviews } from '@serverless-saas/database/schema/fairness';
import { auditLog } from '@serverless-saas/database/schema/audit';
import type { FairnessCheckResult } from '@serverless-saas/database/schema/fairness';
import { isPlatformAdmin } from './ops.guard';
import { checkDemographicLanguage, checkLanguageRestriction, checkInclusiveScope, deriveOverallStatus } from './agents.fairness';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

// GET /ops/fairness — all agents across all tenants with latest review
export async function handleListFairnessReviews(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const rows = await db.execute(sql`
        SELECT
            a.id          AS agent_id,
            a.name        AS agent_name,
            a.type        AS agent_type,
            a.status      AS agent_status,
            a.tenant_id,
            t.name        AS tenant_name,
            t.slug        AS tenant_slug,
            r.id          AS review_id,
            r.overall_status,
            r.run_at,
            r.check_results
        FROM agents a
        INNER JOIN tenants t ON a.tenant_id = t.id
        LEFT JOIN LATERAL (
            SELECT id, overall_status, run_at, check_results
            FROM agent_fairness_reviews
            WHERE agent_id = a.id
            ORDER BY run_at DESC
            LIMIT 1
        ) r ON true
        WHERE a.is_internal = false
        ORDER BY a.name ASC
    `);

    return c.json({ agents: rows.rows });
}

// POST /ops/fairness/:agentId/run — run check from ops (no tenant scope restriction)
export async function handleOpsRunFairness(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('agentId') as string;

    const [agent] = await db
        .select({ id: agents.id, tenantId: agents.tenantId, description: agents.description })
        .from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const skills = await db
        .select({ systemPrompt: agentSkills.systemPrompt, tools: agentSkills.tools })
        .from(agentSkills).where(eq(agentSkills.agentId, agentId));

    const texts = [
        agent.description ?? '',
        ...skills.map((s: { systemPrompt: string; tools: string[] }) => s.systemPrompt),
        ...skills.flatMap((s: { systemPrompt: string; tools: string[] }) => s.tools),
    ];

    const checkResults: FairnessCheckResult[] = [
        checkDemographicLanguage(texts),
        checkLanguageRestriction(texts),
        checkInclusiveScope(texts),
    ];
    const overallStatus = deriveOverallStatus(checkResults);

    const requestContext = c.get('requestContext') as any;
    const runBy = requestContext?.userId ?? 'ops';

    const [review] = await db.insert(agentFairnessReviews).values({
        agentId,
        tenantId: agent.tenantId,
        runBy,
        overallStatus,
        checkResults,
    }).returning();

    return c.json({ review });
}

// GET /ops/fairness/response-audits — Sutra 1 runtime response checks from audit_log
export async function handleListResponseAudits(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const rows = await db
        .select({
            id: auditLog.id,
            tenantId: auditLog.tenantId,
            resourceId: auditLog.resourceId,
            metadata: auditLog.metadata,
            createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(and(
            eq(auditLog.action, 'response_fairness_audit'),
            eq(auditLog.actorType, 'agent'),
        ))
        .orderBy(desc(auditLog.createdAt))
        .limit(100);

    return c.json({ audits: rows });
}
