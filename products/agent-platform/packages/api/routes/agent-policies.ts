import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentPolicies } from '@serverless-saas/agent-schema/conversations';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const agentPoliciesRoutes = new Hono<AppEnv>();

// Verify agent belongs to tenant — used before every operation
async function resolveAgent(agentId: string, tenantId: string) {
    const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .limit(1);
    return agent ?? null;
}

const policySchema = z.object({
    allowedActions: z.array(z.string()).optional().default([]),
    blockedActions: z.array(z.string()).optional().default([]),
    requiresApproval: z.array(z.string()).optional().default([]),
    maxTokensPerMessage: z.number().int().positive().nullable().optional(),
    maxMessagesPerConversation: z.number().int().positive().nullable().optional(),
});

// GET /agents/:agentId/policies — get policy for agent (one per agent/tenant)
agentPoliciesRoutes.get('/:agentId/policies', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [data] = await db
        .select()
        .from(agentPolicies)
        .where(and(
            eq(agentPolicies.agentId, agentId),
            eq(agentPolicies.tenantId, tenantId),
        ))
        .limit(1);

    // Return null data when no policy is set yet — caller creates via PUT
    return c.json({ data: data ?? null });
});

// PUT /agents/:agentId/policies — upsert policy (create if not exists, update if exists)
// Unique constraint on [agentId, tenantId] — one policy per agent per tenant
agentPoliciesRoutes.put('/:agentId/policies', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agents', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const result = policySchema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const { allowedActions, blockedActions, requiresApproval, maxTokensPerMessage, maxMessagesPerConversation } = result.data;

    const [upserted] = await db.insert(agentPolicies)
        .values({
            agentId,
            tenantId,
            allowedActions,
            blockedActions,
            requiresApproval,
            maxTokensPerMessage: maxTokensPerMessage ?? null,
            maxMessagesPerConversation: maxMessagesPerConversation ?? null,
        })
        .onConflictDoUpdate({
            target: [agentPolicies.agentId, agentPolicies.tenantId],
            set: {
                allowedActions,
                blockedActions,
                requiresApproval,
                maxTokensPerMessage: maxTokensPerMessage ?? null,
                maxMessagesPerConversation: maxMessagesPerConversation ?? null,
                updatedAt: new Date(),
            },
        })
        .returning();

    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_policy_upserted', resource: 'agent_policy', resourceId: upserted.id, metadata: { agentId, allowedActions, blockedActions, requiresApproval }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    return c.json({ data: upserted });
});
