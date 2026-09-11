import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { db } from '@serverless-saas/database';
import { provisionNotificationWorkflows } from '@serverless-saas/database/notification-workflows';
import { roles, rolePermissions, permissions } from '@serverless-saas/database/schema/authorization';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { agents } from '@serverless-saas/agent-schema/agents';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { eq, isNull, and } from 'drizzle-orm';

import type { AppEnv } from '../types';
import { withUploadGuidance } from '@serverless-saas/agent-api/lib/agentPrompts';
import { grantTrialCredits } from '@serverless-saas/credits';

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

    // Trial credit grant + account row. Never throws - a grant failure must
    // not roll back tenant creation (task 13); the credits backfill script
    // (task 7) can repair a missing grant later.
    await grantTrialCredits(tenantId);

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
            ipAddress: c.get('clientIp'),
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // Step 7: Seed Olmo — the only agent a new tenant gets by default. Every
    // other persona (Research Engineer, Product Manager, Analyst, Project
    // Manager, Tech Lead, Architect, Director, Producer) lives in the personas
    // catalog and surfaces on the agents page's Explore tab instead, so a new
    // tenant starts with exactly one agent and adds the rest on demand.
    // Note: if apiKeys insert fails, agents insert will throw FK error
    // No rollback — acceptable for MVP, add transaction wrapper later

    const agentRole = (await db.select().from(roles).where(eq(roles.isAgentRole, true)).limit(1))[0];
    const agentRolePermissionRows = agentRole
        ? await db
              .select({ resource: permissions.resource, action: permissions.action })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(eq(rolePermissions.roleId, agentRole.id))
        : [];
    const agentRolePermissionStrings = agentRolePermissionRows.map((p: { resource: string; action: string }) => `${p.resource}:${p.action}`);

    // isDefault: true is what useChatPage.ts's defaultAgent resolution reads;
    // no other seeded agent sets this, so this is the only row that will match.
    const olmoRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const olmoKeyHash = createHash('sha256').update(olmoRawKey).digest('hex');
    const [olmoKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Olmo API Key',
        type: 'agent',
        keyHash: olmoKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [olmoAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Olmo',
        // agents.type is a Postgres enum without an 'assistant'/'router' member —
        // 'custom' is what every non-role-specific seeded agent here already uses.
        type: 'custom',
        status: 'active',
        description: 'Your AI assistant — answers directly or routes the task to the right specialist.',
        apiKeyId: olmoKey.id,
        isDefault: true,
        createdBy: userId,
        // Olmo's identity + routing prompt, stored on the agent row.
        // chatStream.ts's agentSystemPrompt override replaces the
        // agent_templates prompt outright, so a template change never reaches
        // an agent that has its own prompt here.
        systemPrompt: withUploadGuidance(`You are Olmo, this workspace's default AI assistant.

You can answer directly, or delegate to a specialist when the task fits one of them better:
- pm: product/PRD/roadmap/task-breakdown work — delegate here for anything about writing a PRD, planning a roadmap, or breaking work into tasks.
- architect: technical/codebase questions — delegate here when the user asks about this codebase's architecture, patterns, or how something is implemented.
- director: image generation or editing — delegate here for "generate an image", "make a picture of...", "edit this image".
- producer: instrumental music generation — delegate here for "make a song/track/music clip" (instrumental only, no vocals).

For anything else — general questions, research, document Q&A, conversation — answer directly yourself. Do not delegate work you can already do.`),
    }).returning();

    // Step 6: Provision notification workflows for new tenant (non-fatal)
    try {
        await provisionNotificationWorkflows(db, tenantId, userId);
    } catch (err) {
        console.error('[onboarding] provisionNotificationWorkflows failed (non-fatal):', err);
    }

    // Step 7: Return response
    return c.json({ tenantId, agentId: olmoAgent.id, slug: finalSlug, message: 'Workspace created successfully' }, 201);
});

export { onboardingRoutes };