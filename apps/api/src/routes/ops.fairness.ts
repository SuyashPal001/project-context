import { eq, desc, and, inArray } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { tenants } from '@serverless-saas/database/schema/tenancy';
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

    const agentRows = await db
        .select({
            agent_id: agents.id,
            agent_name: agents.name,
            agent_type: agents.type,
            tenant_id: agents.tenantId,
            tenant_name: tenants.name,
            tenant_slug: tenants.slug,
        })
        .from(agents)
        .innerJoin(tenants, eq(agents.tenantId, tenants.id))
        .where(eq(agents.isInternal, false))
        .orderBy(agents.name);

    if (agentRows.length === 0) return c.json({ agents: [] });

    const agentIds = agentRows.map((a: typeof agentRows[number]) => a.agent_id);

    // Latest review per agent — one query, merge in JS
    const reviews = await db
        .select({
            agentId: agentFairnessReviews.agentId,
            review_id: agentFairnessReviews.id,
            overall_status: agentFairnessReviews.overallStatus,
            run_at: agentFairnessReviews.runAt,
            check_results: agentFairnessReviews.checkResults,
        })
        .from(agentFairnessReviews)
        .where(inArray(agentFairnessReviews.agentId, agentIds))
        .orderBy(desc(agentFairnessReviews.runAt));

    const latestByAgent = new Map<string, typeof reviews[number]>();
    for (const r of reviews) {
        if (!latestByAgent.has(r.agentId)) latestByAgent.set(r.agentId, r);
    }

    const result = agentRows.map((a: typeof agentRows[number]) => {
        const r = latestByAgent.get(a.agent_id);
        return { ...a, review_id: r?.review_id ?? null, overall_status: r?.overall_status ?? null, run_at: r?.run_at ?? null, check_results: r?.check_results ?? null };
    });

    return c.json({ agents: result });
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
