import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { db } from '@serverless-saas/database';
import { provisionNotificationWorkflows } from '@serverless-saas/database/seeds/notification-workflows';
import { roles } from '@serverless-saas/database/schema/authorization';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { agents, agentTemplates } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { eq, isNull, and, desc } from 'drizzle-orm';

import type { AppEnv } from '../types';

const onboardingSchema = z.object({
    workspaceName: z.string().min(3).max(20),
    purpose: z.string().optional(),
});

const generateSlug = (name: string) => {
    return name.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '-');
};

const checkSlugAvailability = async (slug: string) => {
    const tenant = (await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1))[0];
    return !tenant;
};

const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.post('/complete', async (c) => {
    // Step 1: Validate request body
    const body = await c.req.json();
    const parsed = onboardingSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: parsed.error.errors[0].message }, 400);
    }
    const { workspaceName } = parsed.data;

    // Step 2: Get userId from context (set by userUpsertMiddleware)
    const userId = c.get('userId');
    if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    // Guard: if user already owns a workspace, return it instead of creating another.
    // Prevents duplicate workspaces from auth method switches (e.g. email → Google OAuth).
    const ownerRole = (await db.select().from(roles).where(and(eq(roles.name, 'owner'), isNull(roles.tenantId))).limit(1))[0];
    if (ownerRole) {
        const existing = await db
            .select({ tenantId: memberships.tenantId, slug: tenants.slug })
            .from(memberships)
            .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
            .where(and(eq(memberships.userId, userId), eq(memberships.roleId, ownerRole.id), eq(memberships.status, 'active')))
            .limit(1);
        if (existing[0]) {
            return c.json({ tenantId: existing[0].tenantId, slug: existing[0].slug, message: 'Workspace already exists' }, 200);
        }
    }

    // Step 3: Generate unique slug
    const slug = generateSlug(workspaceName);
    const isAvailable = await checkSlugAvailability(slug);
    let finalSlug = slug;
    if (!isAvailable) {
        const suffix = Math.random().toString(36).substring(2, 6);
        finalSlug = `${slug}-${suffix}`;
    }

    // Step 4: Find owner role
    const role = (await db.select().from(roles).where(and(eq(roles.name, 'owner'), isNull(roles.tenantId))).limit(1))[0];
    if (!role) {
        return c.json({ error: 'System configuration error' }, 500);
    }

    // Step 5: Sequential inserts (Neon HTTP driver does not support transactions)
    const [tenant] = await db.insert(tenants).values({
        name: workspaceName,
        slug: finalSlug,
        type: 'startup',
        status: 'active',
    }).returning();

    await db.insert(memberships).values({
        userId,
        tenantId: tenant.id,
        roleId: role.id,
        memberType: 'human',
        status: 'active',
        joinedAt: new Date(),
    });

    await db.insert(subscriptions).values({
        tenantId: tenant.id,
        plan: 'free',
        status: 'active',
        billingCycle: 'monthly',
        startedAt: new Date(),
    });

    const tenantId = tenant.id;

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'tenant_created',
            resource: 'tenant',
            resourceId: tenantId,
            metadata: { slug: finalSlug },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // Step 7: Seed default agent (Saarthi) for new tenant
    // Note: if apiKeys insert fails, agents insert will throw FK error
    // No rollback — acceptable for MVP, add transaction wrapper later

    // Resolve system prompt from active published template (ADR-030).
    // Falls back to hardcoded string if no published template exists.
    const [publishedTemplate] = await db
        .select({
            systemPrompt: agentTemplates.systemPrompt,
            tools: agentTemplates.tools,
            model: agentTemplates.model,
        })
        .from(agentTemplates)
        .where(eq(agentTemplates.status, 'published'))
        .orderBy(desc(agentTemplates.version))
        .limit(1);

    if (!publishedTemplate) {
        console.warn('[onboarding] No published agent template found, using fallback prompt');
    }

    const resolvedSystemPrompt = publishedTemplate
        ? publishedTemplate.systemPrompt.replace(/\$\{workspaceName\}/g, workspaceName)
        : `You are Saarthi, an AI assistant for ${workspaceName}. You help users by answering questions from their organization's uploaded documents. Always call retrieve_documents when the user asks about company-specific information. Cite retrieved content inline as [1][2][3].`;

    const resolvedTools = publishedTemplate?.tools ?? [];
    const resolvedModel = publishedTemplate?.model ?? null;

    const rawKey = `ak_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const [saarthiKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Saarthi API Key',
        type: 'agent',
        keyHash,
        permissions: [],
        status: 'active',
        createdBy: userId,
    }).returning();

    const [saarthiAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Saarthi',
        type: 'custom',
        status: 'active',
        apiKeyId: saarthiKey.id,
        model: resolvedModel,
        createdBy: userId,
    }).returning();

    await db.insert(agentSkills).values({
        agentId: saarthiAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: resolvedSystemPrompt,
        tools: resolvedTools,
        status: 'active',
    });

    // Seed PM Agent as inactive — visible as locked on free plan, activated on upgrade
    const pmRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const pmKeyHash = createHash('sha256').update(pmRawKey).digest('hex');
    const [pmKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'PM Agent API Key',
        type: 'agent',
        keyHash: pmKeyHash,
        permissions: [],
        status: 'active',
        createdBy: userId,
    }).returning();
    const [pmAgent] = await db.insert(agents).values({
        tenantId,
        name: 'PM Agent',
        type: 'custom',
        status: 'paused',
        apiKeyId: pmKey.id,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: pmAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are a PM Agent that helps with product planning, PRDs, roadmaps, and task breakdowns.',
        tools: [],
        status: 'active',
    });

    // Seed Architect Agent as paused — visible in agent list, routes to architectAgent in relay
    const archRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const archKeyHash = createHash('sha256').update(archRawKey).digest('hex');
    const [archKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Architect API Key',
        type: 'agent',
        keyHash: archKeyHash,
        permissions: [],
        status: 'active',
        createdBy: userId,
    }).returning();
    const [archAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Architect',
        type: 'custom',
        status: 'active',
        apiKeyId: archKey.id,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: archAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are the technical architect. Always call retrieve_knowledge before answering any technical question about the codebase.',
        tools: [],
        status: 'active',
    });

    // Step 6: Provision notification workflows for new tenant (non-fatal)
    try {
        await provisionNotificationWorkflows(db, tenantId, userId);
    } catch (err) {
        console.error('[onboarding] provisionNotificationWorkflows failed (non-fatal):', err);
    }

    // Step 7: Return response
    return c.json({ tenantId, agentId: saarthiAgent.id, slug: finalSlug, message: 'Workspace created successfully' }, 201);
});

export { onboardingRoutes };