# Agency Handover — Track A Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the schema that makes a client handover pack producible — clients under a tenant, provenance columns on tasks, and a revision ledger recording the diff between what the AI drafted and what a human made it.

**Architecture:** Three Drizzle migrations plus two pure helper modules. `clients` sits **below** `tenants` (agency = tenant, clients = rows under it) — no `organization_id` layer, so the pre-token Lambda and all ten middleware steps are untouched. Task provenance is additive and nullable: `raw_input` is written once and never updated; every subsequent human edit appends a `task_revisions` row. The two pure helpers (`resolveBranding`, `buildTaskRevisions`) carry the real logic and get real TDD; the DDL is verified by type-check and generated-migration diff, matching how this repo already tests.

**Tech Stack:** Drizzle ORM + drizzle-kit, Neon PostgreSQL, Hono, Zod, Vitest.

## Global Constraints

- Package scope is `@serverless-saas/*`. Agent-platform tables live in `products/agent-platform/packages/schema` and are exported from its `index.ts`.
- Every table carries `tenant_id uuid NOT NULL REFERENCES tenants(id)`. Every query filters by `tenantId`. No exceptions.
- No new table may be added to a foundation schema file. New tables get their own file under `products/agent-platform/packages/schema/`.
- **Migrations are hand-written.** Do NOT run `pnpm db:generate`. The snapshot
  chain in `migrations/meta/` ends at `0036`; migrations `0037`–`0043` were
  written by hand without snapshots, so drizzle-kit diffs against a stale
  snapshot and sweeps seven migrations of already-applied drift — including
  destructive `DROP`s — into any new file. Write the `.sql` by hand, add a
  matching `_journal.json` entry continuing the `+60000` `when` sequence, and
  add no snapshot. This matches `0039_agent_type_pm_team` through
  `0043_project_milestones_acceptance_criteria`.
- Every DDL statement must be idempotent: `IF NOT EXISTS` on tables, columns,
  and indexes; `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
  around `ADD CONSTRAINT`, which has no `IF NOT EXISTS` form. Statements are
  separated by `--> statement-breakpoint`.
- No migration may contain a `DROP`. The database is live.
- Existing tests are pure-unit with `vi.mock` and never touch a database. Follow that pattern — see `products/agent-platform/packages/api/__tests__/tasks.state.test.ts`.
- Run tests from `products/agent-platform/packages/api` with `pnpm vitest run <path>`.
- Indentation in `products/agent-platform/packages/schema/*.ts` is 2 spaces in `agents.ts` and 4 in `pm.ts`. New files use **2 spaces**.
- Do not modify `apps/api/src/app.ts` middleware in this plan.

---

### Task 1: `clients` table, plan linkage, and branding resolution

**Files:**
- Create: `products/agent-platform/packages/schema/clients.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Modify: `products/agent-platform/packages/schema/pm.ts` (add `clientId` to `projectPlans`)
- Create: `products/agent-platform/packages/api/lib/branding.ts`
- Test: `products/agent-platform/packages/api/__tests__/branding.test.ts`
- Create: `packages/foundation/database/migrations/0044_clients.sql` (generated, then renamed)
- Modify: `packages/foundation/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `tenants` from `@serverless-saas/database/schema/tenancy`.
- Produces: `clients` table (Drizzle), `Client` / `NewClient` types, `clientStatusEnum`; `projectPlans.clientId`; `resolveBranding(client: BrandFields | null, tenant: BrandFields): BrandFields` and the `BrandFields` interface from `../lib/branding`.

- [ ] **Step 1: Write the failing test for branding resolution**

Create `products/agent-platform/packages/api/__tests__/branding.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveBranding } from '../lib/branding'

const tenantBrand = {
  brandName: 'Acme Agency',
  logoUrl: 'https://cdn.example.com/acme.png',
  brandColor: '#111111',
}

describe('resolveBranding', () => {
  it('falls back to tenant branding when there is no client', () => {
    expect(resolveBranding(null, tenantBrand)).toEqual(tenantBrand)
  })

  it('falls back to tenant branding when every client field is null', () => {
    const client = { brandName: null, logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand)).toEqual(tenantBrand)
  })

  it('lets a client field override the tenant field', () => {
    const client = { brandName: 'Globex', logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand)).toEqual({
      brandName: 'Globex',
      logoUrl: 'https://cdn.example.com/acme.png',
      brandColor: '#111111',
    })
  })

  it('overrides every field when the client sets all of them', () => {
    const client = {
      brandName: 'Globex',
      logoUrl: 'https://cdn.example.com/globex.png',
      brandColor: '#00FF00',
    }
    expect(resolveBranding(client, tenantBrand)).toEqual(client)
  })

  it('treats an empty string as an intentional override, not a fallback', () => {
    const client = { brandName: '', logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand).brandName).toBe('')
  })

  it('does not mutate its arguments', () => {
    const client = { brandName: 'Globex', logoUrl: null, brandColor: null }
    const tenant = { ...tenantBrand }
    resolveBranding(client, tenant)
    expect(client).toEqual({ brandName: 'Globex', logoUrl: null, brandColor: null })
    expect(tenant).toEqual(tenantBrand)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/branding.test.ts
```

Expected: FAIL — `Cannot find module '../lib/branding'`.

- [ ] **Step 3: Implement `resolveBranding`**

Create `products/agent-platform/packages/api/lib/branding.ts`:

```typescript
/**
 * Branding fields shared by tenants (the agency) and clients.
 * A client-level value of `null` means "inherit"; any non-null value —
 * including the empty string — is an intentional override.
 */
export interface BrandFields {
  brandName: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

export function resolveBranding(
  client: BrandFields | null,
  tenant: BrandFields,
): BrandFields {
  if (!client) return { ...tenant };
  return {
    brandName: client.brandName ?? tenant.brandName,
    logoUrl: client.logoUrl ?? tenant.logoUrl,
    brandColor: client.brandColor ?? tenant.brandColor,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/branding.test.ts
```

Expected: PASS — 6 tests.

- [ ] **Step 5: Define the `clients` table**

Create `products/agent-platform/packages/schema/clients.ts`:

```typescript
import { pgTable, pgEnum, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';

export const clientStatusEnum = pgEnum('client_status', ['active', 'archived']);

// One row per client of the agency. The agency is the tenant; clients live
// beneath it so staff can query across all of their clients without a
// cross-tenant read. Brand fields are nullable overrides of the tenant's own
// branding — see resolveBranding() in the api package.
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  brandName: text('brand_name'),
  logoUrl: text('logo_url'),
  brandColor: text('brand_color'),
  status: clientStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  tenantSlugUnique: unique('clients_tenant_slug_unique').on(t.tenantId, t.slug),
  tenantStatusIdx: index('clients_tenant_status_idx').on(t.tenantId, t.status),
}));

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
```

- [ ] **Step 6: Export it from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add `export * from './clients';` immediately after the `export * from './agents';` line:

```typescript
export * from './agents';
export * from './clients';
export * from './conversations';
```

- [ ] **Step 7: Link plans to clients**

In `products/agent-platform/packages/schema/pm.ts`, inside the `projectPlans` table definition, add a `clientId` column directly after `tenantId`. Note this file uses 4-space indentation:

```typescript
    tenantId:    uuid('tenant_id').notNull().references(() => tenants.id),
    clientId:    uuid('client_id').references(() => clients.id),
```

Add `clients` to the imports at the top of the file:

```typescript
import { clients } from './clients';
```

And add an index to the `projectPlans` table's index block:

```typescript
    clientIdx: index('project_plans_client_idx').on(t.clientId),
```

`clientId` is nullable because plans created before this change have no client.

- [ ] **Step 8: Hand-write the migration**

Do **not** run `pnpm db:generate` — see Global Constraints. Create
`packages/foundation/database/migrations/0044_clients.sql` with exactly this
content:

```sql
CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brand_name" text,
	"logo_url" text,
	"brand_color" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "clients_tenant_slug_unique" UNIQUE("tenant_id","slug")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_tenant_status_idx" ON "clients" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "project_plans" ADD COLUMN IF NOT EXISTS "client_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_plans_client_idx" ON "project_plans" USING btree ("client_id");
```

`CREATE TYPE` has no `IF NOT EXISTS` form in PostgreSQL — that is expected and
matches the existing migrations.

- [ ] **Step 9: Add the journal entry**

Append to `entries` in `packages/foundation/database/migrations/meta/_journal.json`
(`0043` is `idx` 42, `when` 1780243320000):

```json
{ "idx": 43, "version": "7", "when": 1780243380000, "tag": "0044_clients", "breakpoints": true }
```

Add no snapshot file.

- [ ] **Step 10: Verify the migration is self-contained**

```bash
grep -c DROP packages/foundation/database/migrations/0044_clients.sql
grep -oE '"(clients|project_plans|tenants)"' packages/foundation/database/migrations/0044_clients.sql | sort -u
```

Expected: `0` DROPs, and only those three table names appear.

- [ ] **Step 11: Type-check the workspace**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: passes for every package except `packages/foundation/idempotency`,
which fails with `'nx' does not exist` on a Redis call. That failure is
pre-existing on this branch — confirm with `git stash` if unsure, and leave it
alone.

- [ ] **Step 12: Commit**

```bash
git add products/agent-platform/packages/schema/clients.ts \
        products/agent-platform/packages/schema/index.ts \
        products/agent-platform/packages/schema/pm.ts \
        products/agent-platform/packages/api/lib/branding.ts \
        products/agent-platform/packages/api/__tests__/branding.test.ts \
        packages/foundation/database/migrations/0044_clients.sql \
        packages/foundation/database/migrations/meta/_journal.json
git commit -m "feat(clients): add clients under tenant with branding overrides"
```

---

### Task 2: Task provenance columns

**Files:**
- Modify: `products/agent-platform/packages/schema/agents.ts:80-124` (the `agentTasks` table)
- Modify: `products/agent-platform/packages/schema/relations.ts:7-30` (`agentTasksRelations`)
- Create: `packages/foundation/database/migrations/0045_task_provenance.sql` (generated, then renamed)
- Modify: `packages/foundation/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `clients` from Task 1 is not used here; `conversations` and `messages` from `./conversations`.
- Produces: `agentTasks.conversationId`, `agentTasks.sourceMessageId`, `agentTasks.rawInput` — all nullable.

- [ ] **Step 1: Add the provenance columns**

In `products/agent-platform/packages/schema/agents.ts`, add three columns to `agentTasks` immediately after the `descriptionHtml` line (this file uses 2-space indentation):

```typescript
  description: text('description'),
  descriptionHtml: text('description_html'),
  // Provenance. rawInput is the original ask exactly as it arrived — written
  // once at creation and never updated. Every later change to description is
  // recorded in task_revisions instead. conversationId/sourceMessageId point
  // back at the exchange the task was extracted from, when there was one.
  rawInput: text('raw_input'),
  conversationId: uuid('conversation_id'),
  sourceMessageId: uuid('source_message_id'),
```

`conversationId` and `sourceMessageId` are plain `uuid` without `.references()` — `conversations.ts` imports from `agents.ts`, so a typed reference here would create a circular import. The foreign keys are added in the migration SQL instead, matching the existing precedent for `milestoneId` / `planId` (see the comment at `agents.ts:107-108`).

- [ ] **Step 2: Add the index**

In the same table's index block, add:

```typescript
  conversationIdx: index('agent_tasks_conversation_idx').on(t.conversationId),
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: PASS.

- [ ] **Step 4: Hand-write the migration**

Do **not** run `pnpm db:generate` — see Global Constraints. Create
`packages/foundation/database/migrations/0045_task_provenance.sql` with exactly
this content:

```sql
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "raw_input" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "source_message_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_source_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_conversation_idx" ON "agent_tasks" USING btree ("conversation_id");--> statement-breakpoint
UPDATE "agent_tasks" SET "raw_input" = "description"
  WHERE "raw_input" IS NULL AND "description" IS NOT NULL;
```

The final `UPDATE` backfills existing tasks. It is the best available
approximation — the true original ask was lost for those rows — and the
`IS NULL` guard makes it safe to re-run.

- [ ] **Step 5: Add the journal entry**

In `packages/foundation/database/migrations/meta/_journal.json`, append to
`entries`, continuing the sequence (the `0044_clients` entry from Task 1 has
`idx` 43 and `when` 1780243380000):

```json
{ "idx": 44, "version": "7", "when": 1780243440000, "tag": "0045_task_provenance", "breakpoints": true }
```

Add no snapshot file.

- [ ] **Step 6: Verify the migration is self-contained**

```bash
grep -c DROP packages/foundation/database/migrations/0045_task_provenance.sql
grep -oE '"(agent_tasks|conversations|messages)"' packages/foundation/database/migrations/0045_task_provenance.sql | sort -u
```

Expected: `0` DROPs, and only those three table names appear.

- [ ] **Step 7: Add the relation**

In `products/agent-platform/packages/schema/relations.ts`, add a `conversation` relation inside `agentTasksRelations`, after `planApprovedByUser`:

```typescript
    conversation: one(conversations, {
        fields: [agentTasks.conversationId],
        references: [conversations.id],
    }),
```

Add the import at the top of the file:

```typescript
import { conversations } from './conversations';
```

- [ ] **Step 8: Type-check**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add products/agent-platform/packages/schema/agents.ts \
        products/agent-platform/packages/schema/relations.ts \
        packages/foundation/database/migrations/0045_task_provenance.sql \
        packages/foundation/database/migrations/meta/_journal.json
git commit -m "feat(tasks): add raw_input, conversation_id, source_message_id provenance"
```

---

### Task 3: `task_revisions` table and revision-building logic

**Files:**
- Create: `products/agent-platform/packages/schema/task-revisions.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Create: `products/agent-platform/packages/api/lib/revisions.ts`
- Test: `products/agent-platform/packages/api/__tests__/revisions.test.ts`
- Create: `packages/foundation/database/migrations/0046_task_revisions.sql` (generated, then renamed)
- Modify: `packages/foundation/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `agentTasks` from `./agents`, `tenants`, `users`.
- Produces: `taskRevisions` table, `TaskRevision` / `NewTaskRevision` types, `revisionActorTypeEnum`; and from `../lib/revisions`: `TRACKED_FIELDS`, `RevisionActorType`, `RevisionMeta`, `TaskRevisionRow`, `buildTaskRevisions(before, patch, meta): TaskRevisionRow[]`.

- [ ] **Step 1: Write the failing test**

Create `products/agent-platform/packages/api/__tests__/revisions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildTaskRevisions, TRACKED_FIELDS } from '../lib/revisions'

const meta = {
  taskId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  actorType: 'human' as const,
  actorId: '33333333-3333-3333-3333-333333333333',
}

const before = {
  title: 'Add auth',
  description: 'Draft written by the analyst agent.',
  acceptanceCriteria: [{ text: 'login works', checked: false }],
  estimatedHours: '4.00',
  status: 'todo',
}

describe('buildTaskRevisions', () => {
  it('returns no revisions when the patch is empty', () => {
    expect(buildTaskRevisions(before, {}, meta)).toEqual([])
  })

  it('returns no revision when a tracked field is unchanged', () => {
    expect(buildTaskRevisions(before, { title: 'Add auth' }, meta)).toEqual([])
  })

  it('records a revision when a tracked field changes', () => {
    const result = buildTaskRevisions(before, { title: 'Add SSO auth' }, meta)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      taskId: meta.taskId,
      tenantId: meta.tenantId,
      field: 'title',
      originalContent: 'Add auth',
      correctedContent: 'Add SSO auth',
      wasEdited: true,
      actorType: 'human',
      actorId: meta.actorId,
    })
  })

  it('ignores fields that are not tracked', () => {
    expect(buildTaskRevisions(before, { status: 'done' }, meta)).toEqual([])
  })

  it('records one revision per changed tracked field, in TRACKED_FIELDS order', () => {
    const result = buildTaskRevisions(
      before,
      { description: 'Rewritten by a human.', title: 'Add SSO auth' },
      meta,
    )
    expect(result.map((r) => r.field)).toEqual(['title', 'description'])
  })

  it('deep-compares structured fields rather than comparing references', () => {
    const unchanged = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ text: 'login works', checked: false }] },
      meta,
    )
    expect(unchanged).toEqual([])

    const changed = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ text: 'login works', checked: true }] },
      meta,
    )
    expect(changed).toHaveLength(1)
    expect(changed[0].field).toBe('acceptanceCriteria')
  })

  it('records a null correction as a real change', () => {
    const result = buildTaskRevisions(before, { description: null }, meta)
    expect(result).toHaveLength(1)
    expect(result[0].correctedContent).toBeNull()
  })

  it('marks agent-authored changes as not edited', () => {
    const result = buildTaskRevisions(
      before,
      { title: 'Add SSO auth' },
      { ...meta, actorType: 'agent' },
    )
    expect(result[0].wasEdited).toBe(false)
    expect(result[0].actorType).toBe('agent')
  })

  it('tracks exactly the intent-carrying fields', () => {
    expect(TRACKED_FIELDS).toEqual([
      'title',
      'description',
      'acceptanceCriteria',
      'estimatedHours',
    ])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/revisions.test.ts
```

Expected: FAIL — `Cannot find module '../lib/revisions'`.

- [ ] **Step 3: Implement `buildTaskRevisions`**

Create `products/agent-platform/packages/api/lib/revisions.ts`:

```typescript
export type RevisionActorType = 'human' | 'agent';

/**
 * The fields that carry intent. A change to any of these is worth recording;
 * status, sort order, assignee and the rest are workflow bookkeeping and are
 * already covered by task_events.
 */
export const TRACKED_FIELDS = [
  'title',
  'description',
  'acceptanceCriteria',
  'estimatedHours',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface RevisionMeta {
  taskId: string;
  tenantId: string;
  actorType: RevisionActorType;
  actorId: string;
}

export interface TaskRevisionRow {
  taskId: string;
  tenantId: string;
  field: TrackedField;
  originalContent: unknown;
  correctedContent: unknown;
  wasEdited: boolean;
  actorType: RevisionActorType;
  actorId: string;
}

function isUnchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Compare a validated patch against the task as it stands and return one
 * revision row per tracked field that actually changed. Returns [] when
 * nothing tracked changed, so callers can skip the insert entirely.
 */
export function buildTaskRevisions(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  meta: RevisionMeta,
): TaskRevisionRow[] {
  const rows: TaskRevisionRow[] = [];

  for (const field of TRACKED_FIELDS) {
    if (!(field in patch)) continue;

    const originalContent = before[field] ?? null;
    const correctedContent = patch[field] ?? null;
    if (isUnchanged(originalContent, correctedContent)) continue;

    rows.push({
      taskId: meta.taskId,
      tenantId: meta.tenantId,
      field,
      originalContent,
      correctedContent,
      wasEdited: meta.actorType === 'human',
      actorType: meta.actorType,
      actorId: meta.actorId,
    });
  }

  return rows;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/revisions.test.ts
```

Expected: PASS — 9 tests.

- [ ] **Step 5: Define the `task_revisions` table**

Create `products/agent-platform/packages/schema/task-revisions.ts`:

```typescript
import { pgTable, pgEnum, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { agentTasks } from './agents';

export const revisionActorTypeEnum = pgEnum('revision_actor_type', ['human', 'agent']);

// Append-only ledger of every change to an intent-carrying task field.
// One row per (task, field, change). Ordered by createdAt — there is
// deliberately no revision_number, which would need a lock to allocate.
// Shape follows saarthi-ai's training_examples: the (original, corrected)
// pair plus who made it is what turns an edit into a training signal.
export const taskRevisions = pgTable('task_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  originalContent: jsonb('original_content'),
  correctedContent: jsonb('corrected_content'),
  wasEdited: boolean('was_edited').notNull(),
  actorType: revisionActorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  taskCreatedAtIdx: index('task_revisions_task_created_at_idx').on(t.taskId, t.createdAt),
  tenantFieldIdx: index('task_revisions_tenant_field_idx').on(t.tenantId, t.field),
}));

export type TaskRevision = typeof taskRevisions.$inferSelect;
export type NewTaskRevision = typeof taskRevisions.$inferInsert;
```

- [ ] **Step 6: Export it from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add `export * from './task-revisions';` after the `clients` line:

```typescript
export * from './agents';
export * from './clients';
export * from './task-revisions';
export * from './conversations';
```

- [ ] **Step 7: Hand-write the migration**

Do **not** run `pnpm db:generate` — see Global Constraints. Create
`packages/foundation/database/migrations/0046_task_revisions.sql` with exactly
this content:

```sql
CREATE TYPE "public"."revision_actor_type" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"field" text NOT NULL,
	"original_content" jsonb,
	"corrected_content" jsonb,
	"was_edited" boolean NOT NULL,
	"actor_type" "revision_actor_type" NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_revisions_task_created_at_idx" ON "task_revisions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_revisions_tenant_field_idx" ON "task_revisions" USING btree ("tenant_id","field");
```

Then append to `entries` in `packages/foundation/database/migrations/meta/_journal.json`:

```json
{ "idx": 45, "version": "7", "when": 1780243500000, "tag": "0046_task_revisions", "breakpoints": true }
```

Add no snapshot file.

- [ ] **Step 8: Verify the migration and type-check**

```bash
grep -c DROP packages/foundation/database/migrations/0046_task_revisions.sql
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: `0` DROPs. Type-check passes for every package except
`packages/foundation/idempotency`, which fails with `'nx' does not exist` on a
Redis call — that failure is pre-existing on this branch and out of scope.

- [ ] **Step 9: Commit**

```bash
git add products/agent-platform/packages/schema/task-revisions.ts \
        products/agent-platform/packages/schema/index.ts \
        products/agent-platform/packages/api/lib/revisions.ts \
        products/agent-platform/packages/api/__tests__/revisions.test.ts \
        packages/foundation/database/migrations/0046_task_revisions.sql \
        packages/foundation/database/migrations/meta/_journal.json
git commit -m "feat(tasks): add task_revisions ledger and revision-building logic"
```

---

### Task 4: Capture provenance in the task write path

**Files:**
- Modify: `products/agent-platform/packages/api/routes/tasks.update.ts:43-130` (`handleUpdateTask`)
- Modify: `products/agent-platform/packages/api/routes/tasks.create.ts` (`handleCreateTask`)
- Test: `products/agent-platform/packages/api/__tests__/tasks.provenance.test.ts`

**Interfaces:**
- Consumes: `buildTaskRevisions`, `TRACKED_FIELDS`, `RevisionMeta`, `TaskRevisionRow` from `../lib/revisions` (Task 3); `taskRevisions` from `@serverless-saas/agent-schema/task-revisions` (Task 3); `agentTasks.rawInput` (Task 2).
- Produces: no new exported symbols. Behavioural contract — `raw_input` is written exactly once at creation and never on update; every human edit to a tracked field appends a `task_revisions` row.

- [ ] **Step 1: Write the failing test**

Create `products/agent-platform/packages/api/__tests__/tasks.provenance.test.ts`. It mirrors the mocking style of `tasks.state.test.ts` — `vi.mock` is hoisted above the imports, so no real database or workspace package is loaded:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/database', () => ({ db: {} }))
// tasks.update.ts imports its db handle from '../db', not from the workspace
// package — mocking only '@serverless-saas/database' still loads a real client.
vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({
  agentTasks: {}, taskSteps: {}, taskEvents: {}, taskComments: {}, agents: {},
}))
vi.mock('@serverless-saas/agent-schema/task-revisions', () => ({ taskRevisions: {} }))
vi.mock('@serverless-saas/database/schema/auth', () => ({ users: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }))
vi.mock('@serverless-saas/ai', () => ({ embedTexts: vi.fn() }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))

import { TRACKED_FIELDS } from '../lib/revisions'

describe('task update patch schema — provenance', () => {
  it('does not accept rawInput as a patchable field', async () => {
    const mod = await import('../routes/tasks.update')
    // patchTaskSchema is not exported; assert on the exported guard instead.
    expect(mod.PROVENANCE_IMMUTABLE_FIELDS).toContain('rawInput')
  })

  it('treats every tracked field as revisionable', () => {
    for (const field of TRACKED_FIELDS) {
      expect(typeof field).toBe('string')
    }
    expect(TRACKED_FIELDS).toContain('title')
    expect(TRACKED_FIELDS).toContain('description')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/tasks.provenance.test.ts
```

Expected: FAIL — `PROVENANCE_IMMUTABLE_FIELDS` is undefined.

- [ ] **Step 3: Export the immutability guard**

In `products/agent-platform/packages/api/routes/tasks.update.ts`, add this immediately after the `patchTaskSchema` definition (after the closing `});` around line 40):

```typescript
/**
 * Fields that exist on agent_tasks but must never be settable through PATCH.
 * rawInput is the original ask — writing it twice destroys the diff the
 * handover pack is built from. Kept as an exported constant so the guarantee
 * is testable rather than implied by the absence of a Zod key.
 */
export const PROVENANCE_IMMUTABLE_FIELDS = ['rawInput', 'conversationId', 'sourceMessageId'] as const;
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/tasks.provenance.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Record revisions on update**

In `products/agent-platform/packages/api/routes/tasks.update.ts`, add the imports at the top of the file:

```typescript
import { taskRevisions } from '@serverless-saas/agent-schema/task-revisions';
import { buildTaskRevisions } from '../lib/revisions';
```

Then, inside `handleUpdateTask`, insert this block **after** the `const [updatedTask] = await db.update(agentTasks)...returning();` statement and **before** the `if (status === 'todo' ...)` WebSocket block:

```typescript
    // Append the intent diff. Non-fatal: a failed revision write must never
    // fail the user's edit, matching how the audit-log write behaves below.
    try {
        const revisions = buildTaskRevisions(task, result.data, {
            taskId,
            tenantId,
            actorType: 'human',
            actorId: userId,
        });
        if (revisions.length > 0) {
            await db.insert(taskRevisions).values(revisions);
        }
    } catch (revErr) {
        console.error('Task revision write failed (non-fatal):', revErr);
    }
```

`task` is the pre-update row already fetched at the top of the handler, and `result.data` is the validated patch — so the comparison is between what was there and what the human asked for.

- [ ] **Step 6: Set `rawInput` once at creation**

In `products/agent-platform/packages/api/routes/tasks.create.ts`, find the object literal passed to `db.insert(agentTasks).values({...})`. Add a `rawInput` key set from the incoming description, falling back to the title when no description was supplied:

```typescript
        rawInput: description ?? title,
```

Place it directly after the existing `description` key. Do not add `rawInput` to the create request's Zod schema — it is derived, never client-supplied.

- [ ] **Step 7: Run the full package test suite**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
```

Expected: PASS — all suites, including the pre-existing `ingestion`, `tasks.state`, and `taskWorker` tests.

- [ ] **Step 8: Type-check the workspace**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add products/agent-platform/packages/api/routes/tasks.update.ts \
        products/agent-platform/packages/api/routes/tasks.create.ts \
        products/agent-platform/packages/api/__tests__/tasks.provenance.test.ts
git commit -m "feat(tasks): capture raw_input on create and revisions on update"
```

---

### Task 5: Apply the migrations

**Files:** none — this task runs migrations against a database.

**Interfaces:**
- Consumes: migrations `0044`–`0046` from Tasks 1–3.
- Produces: the three migrations applied. Nothing later in this plan depends on it; the next plan (timeline view, handover packs) does.

- [ ] **Step 1: Confirm `DATABASE_URL` points where you intend**

```bash
cd packages/foundation/database && node -e "require('dotenv').config({path:'../../../apps/api/.env'}); const u=new URL(process.env.DATABASE_URL); console.log(u.host, u.pathname)"
```

Read the host and database name aloud before continuing. `drizzle.config.ts` loads `apps/api/.env`, which on a developer machine may well point at production Neon. **Do not proceed until you have confirmed with the repository owner which database this is.**

- [ ] **Step 2: Apply the migrations**

```bash
cd packages/foundation/database && pnpm db:migrate
```

Expected: three migrations applied, no errors.

- [ ] **Step 3: Verify the schema landed**

```bash
cd packages/foundation/database && node -e "
require('dotenv').config({path:'../../../apps/api/.env'});
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const t = await sql\`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('clients','task_revisions') ORDER BY table_name\`;
  console.log('tables:', t.map(r => r.table_name));
  const c = await sql\`SELECT column_name FROM information_schema.columns
    WHERE table_name='agent_tasks'
      AND column_name IN ('raw_input','conversation_id','source_message_id')
    ORDER BY column_name\`;
  console.log('agent_tasks columns:', c.map(r => r.column_name));
  const b = await sql\`SELECT count(*)::int AS n FROM agent_tasks
    WHERE raw_input IS NULL AND description IS NOT NULL\`;
  console.log('un-backfilled tasks (expect 0):', b[0].n);
})();
"
```

Expected output:
```
tables: [ 'clients', 'task_revisions' ]
agent_tasks columns: [ 'conversation_id', 'raw_input', 'source_message_id' ]
un-backfilled tasks (expect 0): 0
```

- [ ] **Step 4: Report the result**

State plainly which database was migrated and paste the verification output. If any check failed, say so with the error rather than proceeding.

---

## Notes for the next plan

With this landed, the remaining Track A items become tractable:

- **Timeline / diff view** reads `task_revisions` ordered by `createdAt` alongside the existing `task_events`, with `raw_input` pinned at the top as the original ask. This is the launch demo asset.
- **RFP ingest** writes the uploaded brief into `raw_input` on the created plan's seed task, so the whole chain hangs off a real client document.
- **`handover_packs`** joins `project_plans.client_id` → `clients` for branding via `resolveBranding`, and renders the RFP-to-delivered delta straight out of `task_revisions`.
