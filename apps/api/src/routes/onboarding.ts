import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { db } from '@serverless-saas/database';
import { provisionNotificationWorkflows } from '@serverless-saas/database/notification-workflows';
import { roles, rolePermissions, permissions } from '@serverless-saas/database/schema/authorization';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { agents, agentTemplates } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { personas } from '@serverless-saas/agent-schema/personas';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { eq, isNull, and, desc } from 'drizzle-orm';

import type { AppEnv } from '../types';
import { buildResearchEngineerPrompt, withUploadGuidance } from '@serverless-saas/agent-api/lib/agentPrompts';
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

    const resolvedSystemPrompt = withUploadGuidance(
        publishedTemplate
            ? publishedTemplate.systemPrompt.replace(/\$\{workspaceName\}/g, workspaceName)
            : buildResearchEngineerPrompt(workspaceName)
    );

    const resolvedTools = publishedTemplate?.tools ?? [];
    const resolvedModel = publishedTemplate?.model ?? null;

    // Resolve the agent role's permission strings once, shared across all six
    // agents seeded below — avoids six identical role_permissions joins.
    const agentRole = (await db.select().from(roles).where(eq(roles.isAgentRole, true)).limit(1))[0];
    const agentRolePermissionRows = agentRole
        ? await db
              .select({ resource: permissions.resource, action: permissions.action })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(eq(rolePermissions.roleId, agentRole.id))
        : [];
    const agentRolePermissionStrings = agentRolePermissionRows.map((p: { resource: string; action: string }) => `${p.resource}:${p.action}`);

    const rawKey = `ak_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const [researchKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Research Engineer API Key',
        type: 'agent',
        keyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();

    const [researchAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Research Engineer',
        type: 'custom',
        description: 'Answers questions from your uploaded documents and knowledge base. Always retrieves before responding. Cites sources inline.',
        status: 'active',
        apiKeyId: researchKey.id,
        model: resolvedModel,
        createdBy: userId,
    }).returning();

    await db.insert(agentSkills).values({
        agentId: researchAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: resolvedSystemPrompt,
        tools: resolvedTools,
        status: 'active',
    });

    // Seed Olmo — the default router agent every conversation lands on.
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
    const [olmoAgentRow] = await db.insert(agents).values({
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
    }).returning();
    await db.insert(agentSkills).values({
        agentId: olmoAgentRow.id,
        tenantId,
        name: 'default',
        // Identity + routing instructions live here (row-level systemPrompt),
        // not in agent_templates — chatStream.ts's agentSystemPrompt override
        // replaces the agent_templates prompt outright, so a DB-template
        // change would never be seen once this row has its own systemPrompt.
        systemPrompt: withUploadGuidance(`You are Olmo, this workspace's default AI assistant.

You can answer directly, or delegate to a specialist when the task fits one of them better:
- pm: product/PRD/roadmap/task-breakdown work — delegate here for anything about writing a PRD, planning a roadmap, or breaking work into tasks.
- architect: technical/codebase questions — delegate here when the user asks about this codebase's architecture, patterns, or how something is implemented.
- director: image generation or editing — delegate here for "generate an image", "make a picture of...", "edit this image".
- producer: instrumental music generation — delegate here for "make a song/track/music clip" (instrumental only, no vocals).

For anything else — general questions, research, document Q&A, conversation — answer directly yourself. Do not delegate work you can already do.`),
        tools: [],
        status: 'active',
    });

    // Seed Product Manager Agent as paused — visible as locked on free plan, activated on upgrade
    const pmRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const pmKeyHash = createHash('sha256').update(pmRawKey).digest('hex');
    const [pmKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Product Manager API Key',
        type: 'agent',
        keyHash: pmKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [pmAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Product Manager',
        type: 'product_manager',
        status: 'paused',
        description: 'Captures intent, asks the one clarifying question that matters, and orchestrates the full PM workflow from discovery to tasks.',
        apiKeyId: pmKey.id,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: pmAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: withUploadGuidance('You are the Product Manager. Capture user intent, ask one clarifying question, load product context, and hand off to the Analyst. Keep every phase aligned.'),
        tools: [],
        status: 'active',
    });

    // Seed Analyst Agent
    const prdRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const prdKeyHash = createHash('sha256').update(prdRawKey).digest('hex');
    const [prdKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Analyst API Key',
        type: 'agent',
        keyHash: prdKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [analystPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'analyst')).limit(1);
    if (!analystPersona) {
        console.warn('[onboarding] analyst persona not found — run the personas seed before onboarding tenants. Creating Analyst agent with personaId: null.');
    }

    const [prdAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Analyst',
        type: 'analyst',
        status: 'active',
        description: 'Drafts complete PRDs — problem, goals, user stories, functional and non-functional requirements, and success metrics. Edits surgically when you push back.',
        apiKeyId: prdKey.id,
        personaId: analystPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: prdAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: withUploadGuidance('You are the Analyst. Draft a complete PRD covering problem, goals, user stories, functional and non-functional requirements, and success metrics. Edit surgically on feedback. Auto-save every version.'),
        tools: [],
        status: 'active',
    });

    // Seed Project Manager Agent
    const roadmapRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const roadmapKeyHash = createHash('sha256').update(roadmapRawKey).digest('hex');
    const [roadmapKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Project Manager API Key',
        type: 'agent',
        keyHash: roadmapKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [pmPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'pm')).limit(1);
    if (!pmPersona) {
        console.warn('[onboarding] pm persona not found — run the personas seed before onboarding tenants. Creating Project Manager agent with personaId: null.');
    }

    const [roadmapAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Project Manager',
        type: 'project_manager',
        status: 'active',
        description: 'Turns an approved PRD into 3–7 milestones with priorities, target dates, and dependencies. Refuses to plan from an unapproved spec.',
        apiKeyId: roadmapKey.id,
        personaId: pmPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: roadmapAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: withUploadGuidance('You are the Project Manager. Turn approved PRDs into 3–7 milestones with priorities, target dates, and dependencies ordered chronologically. Never plan from an unapproved spec.'),
        tools: [],
        status: 'active',
    });

    // Seed Tech Lead Agent
    const taskRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const taskKeyHash = createHash('sha256').update(taskRawKey).digest('hex');
    const [taskKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Tech Lead API Key',
        type: 'agent',
        keyHash: taskKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [techLeadPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'tech-lead')).limit(1);
    if (!techLeadPersona) {
        console.warn('[onboarding] tech-lead persona not found — run the personas seed before onboarding tenants. Creating Tech Lead agent with personaId: null.');
    }

    const [taskAgentRow] = await db.insert(agents).values({
        tenantId,
        name: 'Tech Lead',
        type: 'tech_lead',
        status: 'active',
        description: 'Decomposes each milestone into 3–7 concrete tasks with acceptance criteria, effort estimates, and priorities. Tasks land on your board, ready to assign.',
        apiKeyId: taskKey.id,
        personaId: techLeadPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: taskAgentRow.id,
        tenantId,
        name: 'default',
        systemPrompt: withUploadGuidance('You are the Tech Lead. Decompose milestones into 3–7 concrete engineering tasks with acceptance criteria, effort estimates, and priorities. Output board-ready tasks.'),
        tools: [],
        status: 'active',
    });

    // Seed Architect Agent
    const archRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const archKeyHash = createHash('sha256').update(archRawKey).digest('hex');
    const [archKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Architect API Key',
        type: 'agent',
        keyHash: archKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [archPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'architect')).limit(1);
    if (!archPersona) {
        console.warn('[onboarding] architect persona not found — run the personas seed before onboarding tenants. Creating Architect agent with personaId: null.');
    }

    const [archAgent] = await db.insert(agents).values({
        tenantId,
        name: 'Architect',
        type: 'architect',
        status: 'active',
        description: 'Knows your migrations, routes, tests, and architectural decisions. Never answers without retrieving. Always cites the file.',
        apiKeyId: archKey.id,
        personaId: archPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: archAgent.id,
        tenantId,
        name: 'default',
        systemPrompt: withUploadGuidance('You are the Architect. Always call retrieve_knowledge before answering any technical question about the codebase. Always cite the file. Say "I don\'t know" when the answer is not in the knowledge base.'),
        tools: [],
        status: 'active',
    });

    // Seed Director Agent
    const [directorPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'director')).limit(1);
    if (!directorPersona) {
        console.warn('[onboarding] director persona not found — run the personas seed before onboarding tenants. Creating Director agent with personaId: null.');
    }

    const directorRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const directorKeyHash = createHash('sha256').update(directorRawKey).digest('hex');
    const [directorKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Director API Key',
        type: 'agent',
        keyHash: directorKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [directorAgentRow] = await db.insert(agents).values({
        tenantId,
        name: 'Director',
        // agents.type is a Postgres enum (products/agent-platform/packages/schema/agents.ts:20:
        // 'ops'|'support'|'billing'|'custom'|'product_manager'|'analyst'|'project_manager'|'tech_lead'|'architect').
        // 'assistant' is NOT a member — it only appears in registry.ts's unrelated, unvalidated
        // display list. 'custom' is what backfill-agents.ts already uses for every agent it seeds.
        type: 'custom',
        status: 'active',
        description: 'Generates and edits images from a description.',
        apiKeyId: directorKey.id,
        personaId: directorPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: directorAgentRow.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are Director. Generate and edit images from a description.',
        tools: [],
        status: 'active',
    });

    // Seed Producer Agent
    const [producerPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'producer')).limit(1);
    if (!producerPersona) {
        console.warn('[onboarding] producer persona not found — run the personas seed before onboarding tenants. Creating Producer agent with personaId: null.');
    }

    const producerRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const producerKeyHash = createHash('sha256').update(producerRawKey).digest('hex');
    const [producerKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Producer API Key',
        type: 'agent',
        keyHash: producerKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [producerAgentRow] = await db.insert(agents).values({
        tenantId,
        name: 'Producer',
        type: 'custom',
        status: 'active',
        description: 'Generates instrumental music clips from a description.',
        apiKeyId: producerKey.id,
        personaId: producerPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: producerAgentRow.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are Producer. Generate instrumental music from a description.',
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
    return c.json({ tenantId, agentId: researchAgent.id, slug: finalSlug, message: 'Workspace created successfully' }, 201);
});

export { onboardingRoutes };