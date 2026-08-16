# Agent Personas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a reusable "persona" — an animated avatar + a base personality that feeds the system prompt + skill tags — sourced from a central `personas` library, and render it across the chat UI instead of the current generic `Bot` icon.

**Architecture:** New `personas` table in the agent-platform schema, referenced by `agents.personaId` (nullable FK). Ops-only CRUD routes (mirroring the existing `agentTemplates` pattern) let the platform team author personas. At chat-stream time, the orchestrator prepends `persona.basePersonality` to the per-agent system prompt it already composes. On the client, a small hook maps existing SSE stream events to an `idle | thinking | responding` state and a shared `PersonaAvatar` component renders the matching asset in the four UI surfaces that currently hardcode `<Bot/>`.

**Tech Stack:** Drizzle ORM (Postgres), Hono routes (`products/agent-platform/packages/api`), Mastra agent orchestrator (`apps/agent-orchestrator`), Next.js/React (`apps/web`), Vitest for backend tests.

## Global Constraints

- Foundation vs product: this is entirely product code (project-context's own agents/PM workflow) — everything goes in `products/agent-platform/*` and `apps/web` product surfaces, nothing in `packages/foundation/*`. Per `CLAUDE.md`.
- Every tenant-scoped DB query must filter by `tenantId` — `personas` itself is NOT tenant-scoped (platform-owned, like `agentTemplates`), but `agents` rows that reference a `personaId` remain tenant-scoped as today.
- Persona authoring is ops/admin-only for this round — gate with `isPlatformAdmin` from `products/agent-platform/packages/api/routes/ops.guard.ts`, same as `agentTemplates.ts`. No tenant-facing persona create/edit UI.
- No art assets exist yet (pending Higgsfield generation) — schema and code must work with `animationStates: null` and render the existing fallback (initials/generic icon) until an asset URL is set. Nothing in this plan blocks on art being ready.
- Migrations are generated from `packages/foundation/database` (its `drizzle.config.ts` already includes `products/agent-platform/packages/schema/index.ts` in its `schema` array) — never add a second drizzle config.
- Never reuse Petdex (or any third-party gallery) character art — confirmed in the spec's Non-goals section. Not relevant to code, but worth restating here since it constrains what a future seed/import script may ever do.

---

## File Structure

New files:
- `products/agent-platform/packages/schema/personas.ts` — `personas` table + relations
- `products/agent-platform/packages/api/routes/personas.ts` — ops CRUD routes (list/get/create/update/publish), mirrors `agentTemplates.ts`
- `products/agent-platform/packages/api/__tests__/personas.test.ts` — route tests
- `products/agent-platform/packages/api/seeds/personas.ts` — seeds the 3 default personas as drafts (`db:seed:personas` script)
- `apps/web/components/platform/personas/types.ts` — `PersonaSummary` type shared by the frontend
- `apps/web/components/platform/personas/PersonaAvatar.tsx` — shared avatar component (state-aware image, falls back to `Bot`/initials)
- `apps/web/components/platform/personas/usePersonaAnimationState.ts` — hook mapping SSE stream events to `idle | thinking | responding`
- `apps/web/components/platform/personas/PersonaDetailModal.tsx` — the "Experts Market" card (avatar, tagline, Official badge, description, example, Fire / Assign Task Now)

Modified files:
- `products/agent-platform/packages/schema/agents.ts` — add `personaId`
- `products/agent-platform/packages/schema/index.ts` — export `./personas`
- `products/agent-platform/packages/api/index.ts` — mount `personasRoutes` under `mountOpsRoutes`
- `products/agent-platform/packages/api/routes/agents.crud.ts` — join `personas` into `handleListAgents`/`handleGetAgent` select
- `products/agent-platform/packages/api/routes/conversations.ts` — join `personas` into the conversation `agent` select (both call sites)
- `apps/agent-orchestrator/src/routes/chatStream.ts` — prepend persona base personality to `agentSystemPrompt`
- `apps/agent-orchestrator/src/usage.ts` — extend `fetchAgentSkill`'s companion lookup (new `fetchAgentPersona`)
- `apps/web/components/platform/agents/types.ts` — `Agent`/`AgentDetail` gain `persona?: PersonaSummary | null`
- `apps/web/components/platform/chat/types.ts` — `Conversation.agent` picks up `persona`
- `apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx` — swap `Bot` icon for `PersonaAvatar`
- `apps/web/components/platform/chat/AgentSelector.tsx` — swap `Bot` icon for `PersonaAvatar`
- `apps/web/components/platform/chat/ConversationList.tsx` — swap `Bot` icon in `AgentSection` for `PersonaAvatar`
- `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx` — add a persona picker alongside the existing avatar upload

---

### Task 1: `personas` schema + `agents.personaId`

**Files:**
- Create: `products/agent-platform/packages/schema/personas.ts`
- Modify: `products/agent-platform/packages/schema/agents.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Create (generated): `packages/foundation/database/migrations/00XX_*.sql`

**Interfaces:**
- Produces: `personas` table, `personaStatusEnum` (`'draft' | 'published'`), `PersonaRow = typeof personas.$inferSelect`, `NewPersonaRow = typeof personas.$inferInsert`. `agents.personaId: uuid | null`.

- [ ] **Step 1: Write `personas.ts`**

```typescript
// products/agent-platform/packages/schema/personas.ts
import { pgTable, uuid, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from '@serverless-saas/database/schema/auth';
import { agents } from './agents';

export const personaStatusEnum = pgEnum('persona_status', ['draft', 'published']);

export type PersonaAnimationStates = {
  idle: string;
  thinking: string;
  responding: string;
};

export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull(),
  basePersonality: text('base_personality').notNull(),
  skillTags: jsonb('skill_tags').$type<string[]>().notNull().default([]),
  animationStates: jsonb('animation_states').$type<PersonaAnimationStates | null>(),
  exampleAssetUrl: text('example_asset_url'),
  exampleCaption: text('example_caption'),
  isOfficial: boolean('is_official').notNull().default(true),
  status: personaStatusEnum('status').notNull().default('draft'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const personasRelations = relations(personas, ({ many }) => ({
  agents: many(agents),
}));

export type PersonaRow = typeof personas.$inferSelect;
export type NewPersonaRow = typeof personas.$inferInsert;
```

- [ ] **Step 2: Add `personaId` to `agents` and wire the relation**

In `products/agent-platform/packages/schema/agents.ts`, add the import and column:

```typescript
import { personas } from './personas';
```

Insert into the `agents` table definition, directly after `avatarUrl: text('avatar_url'),`:

```typescript
  personaId: uuid('persona_id').references(() => personas.id),
```

- [ ] **Step 3: Export the new module from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add:

```typescript
export * from './personas';
```

- [ ] **Step 4: Generate and review the migration**

Run:
```bash
cd packages/foundation/database
pnpm exec drizzle-kit generate
```
Open the generated `migrations/00XX_*.sql` and confirm it contains `CREATE TYPE "persona_status"`, `CREATE TABLE "personas"`, and `ALTER TABLE "agents" ADD COLUMN "persona_id" uuid`. Do not hand-edit generated SQL beyond reviewing it.

- [ ] **Step 5: Apply the migration to the local dev database**

Run:
```bash
pnpm exec drizzle-kit migrate
```
Expected: migration applies with no errors; `\d personas` in `psql` shows the new table.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/schema/personas.ts \
        products/agent-platform/packages/schema/agents.ts \
        products/agent-platform/packages/schema/index.ts \
        packages/foundation/database/migrations/
git commit -m "feat(schema): add personas table and agents.personaId"
```

---

### Task 2: Ops CRUD routes for `personas`

**Files:**
- Create: `products/agent-platform/packages/api/routes/personas.ts`
- Create: `products/agent-platform/packages/api/__tests__/personas.test.ts`
- Modify: `products/agent-platform/packages/api/index.ts`

**Interfaces:**
- Consumes: `personas`, `personaStatusEnum` from `@serverless-saas/agent-schema/personas`; `isPlatformAdmin` from `./ops.guard`; `db` from `../db`.
- Produces: `personasRoutes: Hono<AppEnv>` with `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `POST /:id/publish` — mounted at `/ops/personas`.

- [ ] **Step 1: Write `personas.ts` routes, following `agentTemplates.ts`'s exact shape**

```typescript
// products/agent-platform/packages/api/routes/personas.ts
import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { personas } from '@serverless-saas/agent-schema/personas';
import { isPlatformAdmin } from './ops.guard';
import type { AppEnv } from '@serverless-saas/types';

export const personasRoutes = new Hono<AppEnv>();

const animationStatesSchema = z.object({
    idle: z.string().url(),
    thinking: z.string().url(),
    responding: z.string().url(),
});

// GET /ops/personas — list all personas, newest first
personasRoutes.get('/', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const data = await db.select().from(personas).orderBy(desc(personas.createdAt));
    return c.json({ personas: data });
});

// GET /ops/personas/:id
personasRoutes.get('/:id', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [persona] = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
    if (!persona) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);
    return c.json({ persona });
});

// POST /ops/personas — create a new draft persona
personasRoutes.post('/', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const schema = z.object({
        slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
        name: z.string().min(1).max(100),
        tagline: z.string().min(1).max(200),
        basePersonality: z.string().min(1),
        skillTags: z.array(z.string()).optional(),
        animationStates: animationStatesSchema.optional(),
        exampleAssetUrl: z.string().url().optional(),
        exampleCaption: z.string().max(200).optional(),
        isOfficial: z.boolean().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    const { slug, name, tagline, basePersonality, skillTags, animationStates, exampleAssetUrl, exampleCaption, isOfficial } = result.data;

    const [existing] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, slug)).limit(1);
    if (existing) return c.json({ error: 'Slug already in use', code: 'DUPLICATE_SLUG' }, 409);

    const [created] = await db
        .insert(personas)
        .values({
            slug, name, tagline, basePersonality,
            skillTags: skillTags ?? [],
            animationStates: animationStates ?? null,
            exampleAssetUrl: exampleAssetUrl ?? null,
            exampleCaption: exampleCaption ?? null,
            isOfficial: isOfficial ?? true,
            status: 'draft',
            createdBy: userId,
        })
        .returning();

    return c.json({ persona: created }, 201);
});

// PUT /ops/personas/:id — update a draft persona only
personasRoutes.put('/:id', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [existing] = await db.select({ id: personas.id, status: personas.status }).from(personas).where(eq(personas.id, id)).limit(1);
    if (!existing) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);
    if (existing.status !== 'draft') return c.json({ error: 'Only draft personas can be edited', code: 'INVALID_STATE' }, 409);

    const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        tagline: z.string().min(1).max(200).optional(),
        basePersonality: z.string().min(1).optional(),
        skillTags: z.array(z.string()).optional(),
        animationStates: animationStatesSchema.optional(),
        exampleAssetUrl: z.string().url().optional(),
        exampleCaption: z.string().max(200).optional(),
        isOfficial: z.boolean().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    if (Object.keys(result.data).length === 0) return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);

    const [updated] = await db.update(personas).set({ ...result.data, updatedAt: new Date() }).where(eq(personas.id, id)).returning();
    return c.json({ persona: updated });
});

// POST /ops/personas/:id/publish — a persona needs all three animation states before it can publish
personasRoutes.post('/:id/publish', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [existing] = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
    if (!existing) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);

    const states = existing.animationStates;
    if (!states || !states.idle || !states.thinking || !states.responding) {
        return c.json({ error: 'Persona needs idle, thinking, and responding assets before publishing', code: 'INCOMPLETE_ASSETS' }, 409);
    }

    const [published] = await db.update(personas).set({ status: 'published', updatedAt: new Date() }).where(eq(personas.id, id)).returning();
    return c.json({ persona: published });
});
```

- [ ] **Step 2: Mount the routes**

In `products/agent-platform/packages/api/index.ts`, add the import near the other ops handlers:

```typescript
import { personasRoutes } from './routes/personas';
```

And inside `mountOpsRoutes`, after `opsApp.route('/ops/agent-templates', agentTemplatesRoutes);`:

```typescript
    opsApp.route('/ops/personas', personasRoutes);
```

- [ ] **Step 3: Write the failing tests**

```typescript
// products/agent-platform/packages/api/__tests__/personas.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { personasRoutes } from '../routes/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithJwt(role: string | null) {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('jwtPayload', role ? { 'custom:role': role } : undefined);
        c.set('userId', 'user-1');
        await next();
    });
    app.route('/ops/personas', personasRoutes);
    return app;
}

describe('personasRoutes auth', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects GET / for a non-platform-admin caller', async () => {
        const app = appWithJwt('tenant_owner');
        const res = await app.request('/ops/personas');
        expect(res.status).toBe(403);
    });

    it('rejects POST / for an unauthenticated caller', async () => {
        const app = appWithJwt(null);
        const res = await app.request('/ops/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
    });
});

describe('personasRoutes publish', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects publishing a persona missing animation states', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', animationStates: null }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('INCOMPLETE_ASSETS');
    });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api test personas.test.ts`
Expected: all 3 tests PASS (the route code already exists from Step 1, so this confirms behavior, not TDD-red-first — that's fine here since the auth/validation logic is copied from the proven `agentTemplates.ts` pattern).

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/personas.ts \
        products/agent-platform/packages/api/__tests__/personas.test.ts \
        products/agent-platform/packages/api/index.ts
git commit -m "feat(api): add ops CRUD routes for personas"
```

---

### Task 3: Expose persona data on `agents` and `conversations` responses

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agents.crud.ts`
- Modify: `products/agent-platform/packages/api/routes/conversations.ts`

**Interfaces:**
- Consumes: `personas` from `@serverless-saas/agent-schema/personas`, `agents.personaId` from Task 1.
- Produces: `handleListAgents`/`handleGetAgent` responses gain `persona: { id, slug, name, tagline, animationStates, skillTags, isOfficial } | null` per agent. `GET /conversations` and `GET /conversations/:id` responses gain the same shape nested at `agent.persona`.

- [ ] **Step 1: Add the persona left-join to `handleListAgents`**

In `products/agent-platform/packages/api/routes/agents.crud.ts`, add the import:

```typescript
import { personas } from '@serverless-saas/agent-schema/personas';
```

Replace the `handleListAgents` query:

```typescript
// GET /agents
export async function handleListAgents(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const data = await db
        .select({
            id: agents.id, tenantId: agents.tenantId, name: agents.name, type: agents.type,
            model: agents.model, status: agents.status, llmProviderId: agents.llmProviderId,
            isInternal: agents.isInternal, description: agents.description, avatarUrl: agents.avatarUrl,
            createdAt: agents.createdAt,
            persona: {
                id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
                animationStates: personas.animationStates, skillTags: personas.skillTags, isOfficial: personas.isOfficial,
            },
        })
        .from(agents)
        .leftJoin(personas, eq(agents.personaId, personas.id))
        .where(and(eq(agents.tenantId, tenantId), eq(agents.isInternal, false)));

    return c.json({ data });
}
```

- [ ] **Step 2: Add the same join to `handleGetAgent`**

Update the `handleGetAgent` select to also `leftJoin(personas, eq(agents.personaId, personas.id))` and include the same `persona: {...}` projection, following the pattern from Step 1. Keep the existing `llmProvider`/`createdByName` enrichment logic unchanged — only the base agent select and join change.

- [ ] **Step 3: Add the persona join to `conversations.ts`**

In `products/agent-platform/packages/api/routes/conversations.ts`, add the import:

```typescript
import { personas } from '@serverless-saas/agent-schema/personas';
```

Update the shared `conversationSelect` constant's `agent` field, and both inline duplicates (the `GET /` handler at the top of the file, and the other two call sites using `.innerJoin(agents, eq(conversations.agentId, agents.id))`), to:

```typescript
    agent: {
        id: agents.id, name: agents.name, type: agents.type,
        persona: {
            id: personas.id, name: personas.name, tagline: personas.tagline,
            animationStates: personas.animationStates,
        },
    },
```

And add `.leftJoin(personas, eq(agents.personaId, personas.id))` immediately after each `.innerJoin(agents, ...)` call.

- [ ] **Step 4: Run the existing agent/conversation route tests**

Run: `pnpm --filter @serverless-saas/agent-api test agents conversations`
Expected: PASS — these routes have no persona-specific assertions yet, this just confirms the join didn't break existing behavior (an agent with `personaId: null` must still return `persona: null` from the left join, not throw).

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/agents.crud.ts \
        products/agent-platform/packages/api/routes/conversations.ts
git commit -m "feat(api): expose persona data on agents and conversations responses"
```

---

### Task 4: Frontend types for persona data

**Files:**
- Create: `apps/web/components/platform/personas/types.ts`
- Modify: `apps/web/components/platform/agents/types.ts`
- Modify: `apps/web/components/platform/chat/types.ts`

**Interfaces:**
- Produces: `PersonaSummary` type, consumed by every component in Tasks 6–9.

- [ ] **Step 1: Write `PersonaSummary`**

```typescript
// apps/web/components/platform/personas/types.ts
export interface PersonaAnimationStates {
    idle: string;
    thinking: string;
    responding: string;
}

export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    animationStates: PersonaAnimationStates | null;
    skillTags: string[];
    isOfficial: boolean;
}

export interface PersonaDetail extends PersonaSummary {
    basePersonality: string;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    status: 'draft' | 'published';
}

export interface PersonasResponse {
    personas: PersonaDetail[];
}
```

- [ ] **Step 2: Extend `Agent`/`AgentDetail`**

In `apps/web/components/platform/agents/types.ts`, add the import:

```typescript
import type { PersonaSummary } from "@/components/platform/personas/types";
```

Add to the `Agent` interface (after `description: string | null;`):

```typescript
    persona: PersonaSummary | null;
```

- [ ] **Step 3: Extend `Conversation.agent`**

In `apps/web/components/platform/chat/types.ts`, `Conversation.agent` already types as `Agent | undefined` via the import at the top of the file — no further change needed there, since `Agent` itself now carries `persona`. Verify by re-reading the file after Step 2 that `agent?: Agent` still compiles against the new shape (it does — it's structural).

- [ ] **Step 4: Type-check**

Run: `pnpm --filter web type-check`
Expected: fails only on Task 6–9's not-yet-updated call sites that construct an `Agent` object without `persona` (e.g. test fixtures, if any). Note any such failures for the relevant later task; do not fix them here.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/personas/types.ts \
        apps/web/components/platform/agents/types.ts
git commit -m "feat(web): add PersonaSummary type and wire it into Agent"
```

---

### Task 5: Runtime prompt composition in the orchestrator

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`

**Interfaces:**
- Consumes: `agents.personaId`, `personas.basePersonality` (Task 1).
- Produces: `fetchAgentPersonality(agentId: string): Promise<string | null>` in `usage.ts`. `requestContext.set('agentSystemPrompt', ...)` in `chatStream.ts` now receives persona text prepended when a persona exists.

- [ ] **Step 1: Add `fetchAgentPersonality` next to `fetchAgentSkill` in `usage.ts`**

```typescript
// apps/agent-orchestrator/src/usage.ts — add near fetchAgentSkill
export async function fetchAgentPersonality(agentId: string): Promise<string | null> {
  const p = getPool()
  const res = await p.query<{ base_personality: string | null }>(
    `SELECT p.base_personality
     FROM agents a
     JOIN personas p ON p.id = a.persona_id
     WHERE a.id = $1`,
    [agentId],
  )
  return res.rows[0]?.base_personality ?? null
}
```

- [ ] **Step 2: Prepend persona text in `chatStream.ts`**

In `apps/agent-orchestrator/src/routes/chatStream.ts`, update the import:

```typescript
import { fetchAgentSkill, fetchAgentName, fetchAgentPersonality } from '../usage.js'
```

Replace the block:

```typescript
    const [agentSkill, agentName] = await Promise.all([
      fetchAgentSkill(agentId),
      fetchAgentName(agentId),
    ])
    if (agentSkill?.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
    }
```

with:

```typescript
    const [agentSkill, agentName, personaPersonality] = await Promise.all([
      fetchAgentSkill(agentId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
    ])
    if (agentSkill?.systemPrompt || personaPersonality) {
      const composed = [personaPersonality, agentSkill?.systemPrompt]
        .filter((part): part is string => !!part)
        .join('\n\n')
      requestContext.set('agentSystemPrompt', composed)
    }
```

This preserves today's behavior exactly when an agent has no `personaId` (`personaPersonality` is `null`, `composed` equals `agentSkill.systemPrompt` as before) and layers the persona ahead of the task prompt when one exists, per the spec's composition rule.

- [ ] **Step 3: Manual verification**

There's no existing test file for `chatStream.ts` (it's exercised via the live SSE endpoint) — verify by hand: assign a test agent a `personaId` with a `basePersonality` of `"Speak only in haiku."`, send it a chat message locally (`cd apps/agent-orchestrator && pnpm dev`), and confirm the reply follows that constraint. Then unset `personaId` and confirm behavior reverts to today's plain `agentSkill.systemPrompt`.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(orchestrator): compose persona base personality into the system prompt"
```

---

### Task 6: Animation-state hook (SSE events → idle/thinking/responding)

**Files:**
- Create: `apps/web/components/platform/personas/usePersonaAnimationState.ts`
- Test: `apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts`

**Interfaces:**
- Consumes: the SSE event names already emitted by `chatStream.ts`: `'delta'`, `'tool_call'`, `'tool_done'`, `'done'`, `'error'`.
- Produces: `usePersonaAnimationState(events: EventEmitter-like source): 'idle' | 'thinking' | 'responding'` — a hook the chat page can drive from its existing SSE handling. To keep this task testable in isolation (no live SSE dependency), it exposes a pure reducer plus the hook wrapper:

```typescript
// apps/web/components/platform/personas/usePersonaAnimationState.ts
import { useReducer } from "react";

export type PersonaAnimationState = "idle" | "thinking" | "responding";
export type ChatStreamEventType = "tool_call" | "tool_done" | "delta" | "done" | "error";

export function reducePersonaAnimationState(
    _current: PersonaAnimationState,
    event: ChatStreamEventType,
): PersonaAnimationState {
    switch (event) {
        case "tool_call":
            return "thinking";
        case "delta":
            return "responding";
        case "tool_done":
            return "thinking";
        case "done":
        case "error":
            return "idle";
        default:
            return _current;
    }
}

export function usePersonaAnimationState() {
    const [state, dispatch] = useReducer(reducePersonaAnimationState, "idle");
    return { state, onStreamEvent: dispatch };
}
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts
import { describe, it, expect } from "vitest";
import { reducePersonaAnimationState } from "../usePersonaAnimationState";

describe("reducePersonaAnimationState", () => {
    it("starts idle and moves to thinking on tool_call", () => {
        expect(reducePersonaAnimationState("idle", "tool_call")).toBe("thinking");
    });

    it("moves to responding on delta", () => {
        expect(reducePersonaAnimationState("thinking", "delta")).toBe("responding");
    });

    it("returns to thinking after tool_done (agent still reasoning, not yet streaming)", () => {
        expect(reducePersonaAnimationState("responding", "tool_done")).toBe("thinking");
    });

    it("returns to idle on done", () => {
        expect(reducePersonaAnimationState("responding", "done")).toBe("idle");
    });

    it("returns to idle on error", () => {
        expect(reducePersonaAnimationState("thinking", "error")).toBe("idle");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web test usePersonaAnimationState`
Expected: FAIL — `usePersonaAnimationState.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `usePersonaAnimationState.ts` with the exact content shown above (Interfaces section).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web test usePersonaAnimationState`
Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/personas/usePersonaAnimationState.ts \
        apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts
git commit -m "feat(web): add SSE-event-to-animation-state reducer for personas"
```

---

### Task 7: `PersonaAvatar` component and wiring into the 3 existing surfaces

**Files:**
- Create: `apps/web/components/platform/personas/PersonaAvatar.tsx`
- Modify: `apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx`
- Modify: `apps/web/components/platform/chat/AgentSelector.tsx`
- Modify: `apps/web/components/platform/chat/ConversationList.tsx`

**Interfaces:**
- Consumes: `PersonaSummary` (Task 4), `PersonaAnimationState` (Task 6).
- Produces: `<PersonaAvatar persona={agent.persona} state="idle" size={40} fallbackInitials="D" />` — falls back to the current generic-icon look when `persona` is `null` or has no `animationStates`, so agents without a persona render exactly as they do today.

- [ ] **Step 1: Write `PersonaAvatar.tsx`**

```typescript
// apps/web/components/platform/personas/PersonaAvatar.tsx
"use client";

import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonaSummary } from "./types";
import type { PersonaAnimationState } from "./usePersonaAnimationState";

interface PersonaAvatarProps {
    persona?: PersonaSummary | null;
    state?: PersonaAnimationState;
    size?: number;
    className?: string;
}

export function PersonaAvatar({ persona, state = "idle", size = 40, className }: PersonaAvatarProps) {
    const asset = persona?.animationStates?.[state] ?? persona?.animationStates?.idle;

    if (!asset) {
        return (
            <div
                className={cn("flex shrink-0 items-center justify-center rounded-xl bg-muted border border-border/50", className)}
                style={{ width: size, height: size }}
            >
                <Bot className="h-1/2 w-1/2 text-muted-foreground" />
            </div>
        );
    }

    return (
        // eslint-disable-next-line @next/next/no-img-element -- persona assets are user/ops-uploaded URLs, not static build assets
        <img
            src={asset}
            alt={persona?.name ?? "Agent"}
            width={size}
            height={size}
            className={cn("shrink-0 rounded-xl object-cover border border-border/50", className)}
        />
    );
}
```

- [ ] **Step 2: Wire into `ChatHeader.tsx`**

Remove the `Bot` import if no longer used elsewhere in the file, add:

```typescript
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
```

Replace:

```typescript
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted border border-border/50">
                    <Bot className="h-5 w-5 text-muted-foreground" />
                </div>
```

with:

```typescript
                <PersonaAvatar persona={selectedConversation.agent?.persona} size={40} />
```

- [ ] **Step 3: Wire into `AgentSelector.tsx`**

Replace:

```typescript
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        <Bot className="h-4 w-4" />
                                    </div>
```

with:

```typescript
                                    <PersonaAvatar persona={agent.persona} size={32} className="rounded-full" />
```

Add the import alongside the existing `Bot` import (remove `Bot` if it becomes unused).

- [ ] **Step 4: Wire into `ConversationList.tsx`'s `AgentSection`**

In the `AgentSection` header (both the active-agent branch and the locked-agent branch), replace:

```typescript
                        <Bot className="h-3 w-3 text-muted-foreground/50 shrink-0" />
```

with:

```typescript
                        <PersonaAvatar persona={agent.persona} size={16} className="rounded" />
```

(and the matching locked-agent instance using `text-muted-foreground/40`). Add the import; keep `Bot`'s import only if still used elsewhere in the file (it is not, after both replacements — remove it).

- [ ] **Step 5: Manual verification**

Run `pnpm --filter web dev`, open the chat dashboard for a tenant with at least one agent that has `persona: null` (all existing agents, pre-Task-9) and confirm all three surfaces render identically to before this task (generic icon) — this proves the fallback path, since no persona has real `animationStates` yet at this point in the plan.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/personas/PersonaAvatar.tsx \
        apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx \
        apps/web/components/platform/chat/AgentSelector.tsx \
        apps/web/components/platform/chat/ConversationList.tsx
git commit -m "feat(web): render PersonaAvatar in chat header, agent selector, and conversation list"
```

---

### Task 8: Persona picker in `AgentIdentityCard`

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/agents` is tenant-scoped and doesn't list the persona library — this task adds a tenant-facing read endpoint. Reuses `PersonaSummary` (Task 4).
- Produces: agent's `personaId` becomes editable from this card; `PATCH /api/v1/agents/:id` already accepts arbitrary fields per the existing route (verify `personaId` passes its Zod schema — see Step 1).

- [ ] **Step 1: Confirm (and if needed extend) the `PATCH /agents/:id` schema accepts `personaId`**

Open `products/agent-platform/packages/api/routes/agents.crud.ts` and find `handleUpdateAgent`'s Zod schema. If it does not already include `personaId: z.string().uuid().nullable().optional()`, add it there and pass `personaId` through to the `db.update(agents).set({...})` call alongside `name`/`avatarUrl`. (This mirrors how `avatarUrl` is already handled in that same handler.)

- [ ] **Step 2: Add a tenant-readable persona list endpoint**

Ops routes (`/ops/personas`) are platform-admin-gated and not reachable from the tenant dashboard. Add a minimal published-only listing to the existing tenant-scoped `agentsRoutes` file (`products/agent-platform/packages/api/routes/agents.ts` — the router mounted at `/agents` in `mountApiRoutes`):

```typescript
// GET /agents/personas — published personas only, any authenticated tenant member
agentsRoutes.get('/personas', async (c) => {
    const data = await db
        .select({
            id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
            animationStates: personas.animationStates, skillTags: personas.skillTags, isOfficial: personas.isOfficial,
        })
        .from(personas)
        .where(eq(personas.status, 'published'));
    return c.json({ personas: data });
});
```
Add the `personas` and `eq` imports at the top of that file if not already present.

- [ ] **Step 3: Update `AgentIdentityCard.tsx` to add the persona picker**

Add a query for the persona list and a select control, alongside the existing avatar/name fields. Add to the imports:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { PersonaSummary } from "@/components/platform/personas/types";
```

(`useMutation`/`useQueryClient` are already imported.) Add the query inside the component body:

```typescript
    const { data: personasData } = useQuery<{ personas: PersonaSummary[] }>({
        queryKey: ["personas"],
        queryFn: () => api.get<{ personas: PersonaSummary[] }>("/api/v1/agents/personas"),
    });
```

Extend `form` state to carry `personaId: string | null`, seeded in the existing `useEffect` from `agent.persona?.id ?? null`. Render a `<select>` (or the project's existing `Select` component from `@/components/ui/select` if present — check `apps/web/components/ui/select.tsx` before adding a new dependency) listing `personasData?.personas`, defaulting to "No persona" (`null`). Wire its `onChange` to `setForm(prev => ({ ...prev, personaId: value }))` and `setIsDirty(true)`, same pattern as the existing `Name` input. Include `personaId: form.personaId` in the `updateMutation.mutate` payload and in `mutationFn`'s `api.patch` body.

- [ ] **Step 4: Manual verification**

On the agent detail page, select a persona from the picker, hit Save, and confirm `GET /api/v1/agents/:id` now returns the chosen `persona` object (via Task 3's join) and the `ChatHeader`/`AgentSelector`/`ConversationList` surfaces (Task 7) pick it up on next load.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/agents.crud.ts \
        products/agent-platform/packages/api/routes/agents.ts \
        apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx
git commit -m "feat(web): add persona picker to agent identity settings"
```

---

### Task 9: Persona detail modal (Experts Market card)

**Files:**
- Create: `apps/web/components/platform/personas/PersonaDetailModal.tsx`

**Interfaces:**
- Consumes: `PersonaDetail` (Task 4), `PersonaAvatar` (Task 7).
- Produces: `<PersonaDetailModal persona={p} open={..} onOpenChange={..} onAssign={(personaId) => void} onFire={(personaId) => void} />`. `onAssign`/`onFire` are callback props — this task does not itself decide where the modal is triggered from (that's a follow-up integration into a roster/browse page, explicitly out of scope per the spec's "no tenant-facing browse page decided yet" — this task only builds the reusable modal component).

- [ ] **Step 1: Write the component**

```typescript
// apps/web/components/platform/personas/PersonaDetailModal.tsx
"use client";

import { Pin } from "lucide-react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PersonaAvatar } from "./PersonaAvatar";
import type { PersonaDetail } from "./types";

interface PersonaDetailModalProps {
    persona: PersonaDetail | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAssign: (personaId: string) => void;
    onFire?: (personaId: string) => void;
    isHired?: boolean;
}

export function PersonaDetailModal({ persona, open, onOpenChange, onAssign, onFire, isHired }: PersonaDetailModalProps) {
    if (!persona) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <PersonaAvatar persona={persona} size={64} className="rounded-2xl" />
                        <div>
                            <DialogTitle className="flex items-center gap-2 text-xl">
                                {persona.name}
                            </DialogTitle>
                            {persona.isOfficial && (
                                <Badge variant="outline" className="mt-1 gap-1 text-amber-600 border-amber-300">
                                    <Pin className="h-3 w-3" /> Official
                                </Badge>
                            )}
                        </div>
                    </div>
                </DialogHeader>

                <p className="text-sm text-muted-foreground">{persona.tagline}</p>

                {persona.exampleAssetUrl && (
                    <div className="space-y-1.5">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={persona.exampleAssetUrl} alt={persona.exampleCaption ?? persona.name} className="w-full rounded-lg border border-border" />
                        {persona.exampleCaption && (
                            <p className="text-xs text-muted-foreground">{persona.exampleCaption}</p>
                        )}
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                    {isHired && onFire && (
                        <Button variant="outline" onClick={() => onFire(persona.id)}>Fire</Button>
                    )}
                    <Button onClick={() => onAssign(persona.id)}>Assign Task Now</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
```

Note: per the spec's "Art & product direction" section, `skillTags` are deliberately not rendered as raw chips here — the modal shows `tagline` (a considered sentence) instead. If a future task wants to surface capability detail beyond the tagline, that's a copywriting decision for whoever authors the persona row, not a UI chip list.

- [ ] **Step 2: Manual verification**

Render the component in isolation (e.g. a temporary route or Storybook-less manual mount in a scratch page) with a mock `PersonaDetail` object, confirm it opens/closes via `open`/`onOpenChange`, and that `Fire` only appears when `isHired` is true.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/platform/personas/PersonaDetailModal.tsx
git commit -m "feat(web): add persona detail modal component"
```

---

### Task 10: Seed the 3 default personas (as drafts, pending art)

**Files:**
- Create: `products/agent-platform/packages/api/seeds/personas.ts`
- Modify: `products/agent-platform/packages/api/package.json`

**Interfaces:**
- Consumes: `personas` table (Task 1).
- Produces: 3 draft `personas` rows (`disco`, `saarthi-pm`, `architect`) with real `basePersonality`/`tagline` text but `animationStates: null` — they cannot be published (Task 2's publish route enforces this) until Higgsfield assets exist and someone `PUT`s the asset URLs in.

- [ ] **Step 1: Write the seed script, following `seeds/agent-templates.ts`'s shape**

```typescript
// products/agent-platform/packages/api/seeds/personas.ts
/**
 * Seeds the 3 default personas as drafts. They cannot be published until
 * idle/thinking/responding animation assets exist (generated via Higgsfield)
 * and are attached with PUT /ops/personas/:id.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:personas
 */
import postgres from 'postgres';

const DEFAULT_PERSONAS = [
  {
    slug: 'disco',
    name: 'Disco',
    tagline: 'Your everyday AI assistant — quick answers, real work, no ceremony.',
    basePersonality: 'You are warm, direct, and unpretentious. You get to the point, admit uncertainty plainly, and never pad an answer to sound more impressive.',
    skillTags: ['general-assistant', 'research', 'document-qa'],
  },
  {
    slug: 'saarthi-pm',
    name: 'Saarthi PM',
    tagline: 'Turns a rough idea into a PRD, roadmap, and tracked tasks.',
    basePersonality: 'You think like a product manager who has shipped many times: you ask clarifying questions before writing specs, favor concrete acceptance criteria over vague goals, and flag scope creep early rather than silently absorbing it.',
    skillTags: ['prd-generation', 'roadmap-planning', 'task-breakdown'],
  },
  {
    slug: 'architect',
    name: 'Architect',
    tagline: 'Technical architect with full knowledge of this codebase.',
    basePersonality: 'You reason like a senior engineer reviewing a design: you weigh tradeoffs explicitly, prefer the simplest approach that meets the actual requirement, and call out risk (migration cost, blast radius, reversibility) before recommending a path.',
    skillTags: ['codebase-navigation', 'architecture-review', 'technical-planning'],
  },
] as const;

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1 });

  try {
    const [owner] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`;
    if (!owner) {
      console.warn('[seed:personas] no users exist yet — run this after the first signup');
      return;
    }

    for (const p of DEFAULT_PERSONAS) {
      const [existing] = await sql<{ id: string }[]>`SELECT id FROM personas WHERE slug = ${p.slug} LIMIT 1`;
      if (existing) {
        await sql`
          UPDATE personas
          SET name = ${p.name}, tagline = ${p.tagline}, base_personality = ${p.basePersonality},
              skill_tags = ${sql.json([...p.skillTags])}, updated_at = now()
          WHERE id = ${existing.id}
        `;
        console.log(`[seed:personas] updated ${p.slug}`);
        continue;
      }
      await sql`
        INSERT INTO personas (slug, name, tagline, base_personality, skill_tags, is_official, status, created_by)
        VALUES (${p.slug}, ${p.name}, ${p.tagline}, ${p.basePersonality}, ${sql.json([...p.skillTags])}, true, 'draft', ${owner.id})
      `;
      console.log(`[seed:personas] created ${p.slug}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:personas] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `products/agent-platform/packages/api/package.json`, next to `"db:seed:templates": "tsx seeds/agent-templates.ts"`, add:

```json
    "db:seed:personas": "tsx seeds/personas.ts"
```

- [ ] **Step 3: Run it against local dev**

Run: `pnpm --filter @serverless-saas/agent-api db:seed:personas`
Expected: `[seed:personas] created disco`, `[seed:personas] created saarthi-pm`, `[seed:personas] created architect`. Confirm via `psql`: `SELECT slug, status FROM personas;` shows all 3 as `draft`.

- [ ] **Step 4: Commit**

```bash
git add products/agent-platform/packages/api/seeds/personas.ts \
        products/agent-platform/packages/api/package.json
git commit -m "feat(api): seed the 3 default personas as drafts"
```

---

### Task 11: Wire "Assign Task Now" / "Fire" to real agent creation/deactivation

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agents.crud.ts`
- Modify: `apps/web/components/platform/personas/PersonaDetailModal.tsx`

**Interfaces:**
- Consumes: `handleCreateAgent`, `handleUpdateAgent` (existing routes, extended). `PersonaDetail` (Task 4).
- Produces: `hirePersona(persona: PersonaDetail): Promise<{ agent: Agent }>` and `firePersonaAgent(agentId: string): Promise<void>` helpers, called from wherever `PersonaDetailModal` is mounted.

This closes the spec's "How it works" step 2 (hiring/assigning, firing), which Task 9 deliberately left as bare callback props since no browse/roster page has been decided yet — this task makes the modal's buttons actually do something, independent of where the modal ends up being triggered from.

- [ ] **Step 1: Let `POST /agents` accept an optional `personaId`**

In `handleCreateAgent` (`products/agent-platform/packages/api/routes/agents.crud.ts`), extend the Zod schema:

```typescript
    const result = z.object({
        name: z.string().min(1).max(100),
        type: z.enum(['ops', 'support', 'billing', 'custom']),
        model: z.string().optional(),
        llmProviderId: z.string().uuid().optional(),
        personaId: z.string().uuid().optional(),
    }).safeParse(await c.req.json());
```

And include `personaId: result.data.personaId` in the `db.insert(agents).values({...})` call already in that handler.

- [ ] **Step 2: Add `hirePersona`/`firePersonaAgent` helpers**

```typescript
// apps/web/components/platform/personas/actions.ts
import { api } from "@/lib/api";
import type { Agent, AgentsResponse } from "@/components/platform/agents/types";
import type { PersonaDetail } from "./types";

export async function hirePersona(persona: PersonaDetail): Promise<Agent> {
    const res = await api.post<{ data: { agent: Agent } }>("/api/v1/agents", {
        name: persona.name,
        type: "custom",
        personaId: persona.id,
    });
    return res.data.agent;
}

export async function firePersonaAgent(agentId: string): Promise<void> {
    await api.patch(`/api/v1/agents/${agentId}`, { status: "paused" });
}

export function findAgentForPersona(agents: AgentsResponse["data"], personaId: string): Agent | undefined {
    return agents.find((a) => a.persona?.id === personaId && a.status === "active");
}
```

- [ ] **Step 3: Wire these into `PersonaDetailModal`'s default usage**

Update the component's props to make `onAssign`/`onFire` optional, defaulting to the new helpers when the caller doesn't override them:

```typescript
import { hirePersona, firePersonaAgent } from "./actions";

// inside PersonaDetailModal, replace the direct prop usage:
    const handleAssign = async () => {
        if (onAssign) return onAssign(persona.id);
        await hirePersona(persona);
        onOpenChange(false);
    };

    const handleFire = async () => {
        if (!isHired) return;
        if (onFire) return onFire(persona.id);
    };
```

Update the button handlers to call `handleAssign`/`handleFire` instead of the raw props directly. This keeps the component usable standalone (buttons work with zero wiring from the parent) while still letting a future browse page override the behavior (e.g. to navigate to the new chat after hiring) via the existing `onAssign`/`onFire` props.

- [ ] **Step 4: Manual verification**

Render `PersonaDetailModal` for a published persona with no callback props, click "Assign Task Now", and confirm `GET /api/v1/agents` now includes a new `custom`-type agent with `persona.id` matching. Click "Fire" on that same agent's card (`isHired={true}`) and confirm its `status` becomes `paused` and it drops out of `ConversationList`'s active-agents section into the locked section per existing behavior (`ConversationList.tsx` already branches on `status === 'paused'`).

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/agents.crud.ts \
        apps/web/components/platform/personas/actions.ts \
        apps/web/components/platform/personas/PersonaDetailModal.tsx
git commit -m "feat(web): wire persona hire/fire actions to agent creation and deactivation"
```

---

## Follow-up (explicitly not part of this plan)

- Generating and attaching the actual idle/thinking/responding art via Higgsfield, then `PUT`-ing the asset URLs and publishing each of the 3 seeded personas — an art/content task, not an engineering one.
- Adding an actual tenant-facing "browse personas" page/roster that mounts `PersonaDetailModal` (Task 9/11) — the spec left this open ("Experts Market"-style surface) and it wasn't decided where in the nav this lives. Task 11 makes the modal's buttons functional in isolation so this integration is a small follow-up once the page exists, not a blocker.
- Extending `agentsRoutes`'s `PATCH` to allow non-owner tenant members to change `personaId` if the current permission model restricts identity edits to owners — verify against existing `isOwner` gating in `AgentIdentityCard.tsx` before shipping Task 8 to production.
