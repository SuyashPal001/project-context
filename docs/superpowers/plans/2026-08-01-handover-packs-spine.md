# Handover Packs Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agency builds a client handover pack against a project plan, reviews it against a readiness checklist, sends one tokenised link, and the client reads and signs it.

**Architecture:** Three new tables (`handover_packs`, `pack_sections`, `pack_items`) in the agent-platform schema, one hand-written migration (`0047`). Three pure helper modules carry the real logic and get real TDD — token minting, section seeding, readiness computation. Routes are thin: an authenticated CRUD/lifecycle router mounted at `/handover`, and a public token-resolved router mounted at `/packs`. Two Next.js pages: an authenticated builder and a public portal that never touches an auth cookie.

**Tech Stack:** Drizzle ORM + drizzle-kit, PostgreSQL (Supabase), Hono, Zod, Vitest, Next.js App Router, Tailwind + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-01-handover-packs-design.md`

## Global Constraints

- Package scope is `@serverless-saas/*`. Agent-platform tables live in `products/agent-platform/packages/schema` and are exported from its `index.ts`.
- Every table carries `tenant_id uuid NOT NULL REFERENCES tenants(id)`. Every authenticated query filters by `tenantId`. No exceptions.
- No new table may be added to a foundation schema file.
- **Migrations are hand-written.** Do NOT run `pnpm db:generate`. The snapshot chain in `migrations/meta/` ends at `0036`; drizzle-kit diffs against a stale snapshot and sweeps already-applied drift — including destructive `DROP`s — into any new file. Write the `.sql` by hand, add a matching `_journal.json` entry continuing the `+60000` `when` sequence, and add no snapshot file.
- Every DDL statement must be idempotent: `IF NOT EXISTS` on tables, columns, and indexes; `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;` around `CREATE TYPE` and `ADD CONSTRAINT`, neither of which has an `IF NOT EXISTS` form. Statements are separated by `--> statement-breakpoint`.
- No migration may contain a `DROP`. The database is live.
- Existing tests are pure-unit with `vi.mock` and never touch a database. Follow that pattern — see `products/agent-platform/packages/api/__tests__/tasks.state.test.ts`.
- Run tests from `products/agent-platform/packages/api` with `pnpm vitest run <path>`.
- Indentation: **2 spaces** in `products/agent-platform/packages/schema/*.ts` and `lib/*.ts`; **4 spaces** in `products/agent-platform/packages/api/routes/*.ts`, matching `plans.ts` and `tasks.update.ts`.
- Route handlers read tenancy as `const requestContext = c.get('requestContext') as any; const tenantId = requestContext?.tenant?.id; const permissions = requestContext?.permissions ?? [];` and gate with `hasPermission(permissions, resource, action)` returning `403 { error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }`. Copy this exactly from `routes/plans.ts:23-31`.
- Successful responses are `c.json({ data: ... })`, `201` on create.
- Do not modify `apps/api/src/app.ts` middleware.
- The credentials section ships **seeded but hidden** (`is_visible = false`). No credential storage, no encryption, no reveal path in this plan.

## File Structure

| File | Responsibility |
|---|---|
| `products/agent-platform/packages/schema/handover.ts` | The three tables, enums, inferred types |
| `packages/foundation/database/migrations/0047_handover_packs.sql` | DDL |
| `products/agent-platform/packages/api/lib/pack-token.ts` | Mint/hash the portal token |
| `products/agent-platform/packages/api/lib/handover-template.ts` | The five seeded sections and their default copy |
| `products/agent-platform/packages/api/lib/handover-readiness.ts` | Readiness computation |
| `products/agent-platform/packages/api/routes/handover.ts` | Authenticated pack + section + item CRUD |
| `products/agent-platform/packages/api/routes/handover.lifecycle.ts` | send / revoke, and the signed-lock guard |
| `products/agent-platform/packages/api/routes/packs.public.ts` | Public token-resolved read + sign |
| `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/page.tsx` | Builder |
| `apps/web/app/p/[token]/page.tsx` | Client portal |

Lifecycle is split from CRUD because the two have different reviewers' concerns: CRUD is tenancy and validation, lifecycle is token secrecy and immutability. `handover.ts` would exceed 400 lines combined.

---

### Task 1: `handover` tables, migration, and token minting

**Files:**
- Create: `products/agent-platform/packages/api/lib/pack-token.ts`
- Test: `products/agent-platform/packages/api/__tests__/pack-token.test.ts`
- Create: `products/agent-platform/packages/schema/handover.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Create: `packages/foundation/database/migrations/0047_handover_packs.sql`
- Modify: `packages/foundation/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `tenants` from `@serverless-saas/database/schema/tenancy`, `users` from `@serverless-saas/database/schema/auth`, `files` from `@serverless-saas/database/schema/storage`, `projectPlans` from `./pm`, `clients` from `./clients`.
- Produces: tables `handoverPacks`, `packSections`, `packItems`; enums `packStatusEnum`, `packSectionKindEnum`, `packItemSourceEnum`; types `HandoverPack` / `NewHandoverPack`, `PackSection` / `NewPackSection`, `PackItem` / `NewPackItem`. From `../lib/pack-token`: `mintToken(): string` and `hashToken(token: string): string`.

- [ ] **Step 1: Write the failing test**

Create `products/agent-platform/packages/api/__tests__/pack-token.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mintToken, hashToken } from '../lib/pack-token'

describe('mintToken', () => {
  it('returns a 43-character base64url string', () => {
    const token = mintToken()
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('never returns padding characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(mintToken()).not.toContain('=')
    }
  })

  it('returns a different token on every call', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintToken()))
    expect(tokens.size).toBe(200)
  })
})

describe('hashToken', () => {
  it('returns a 64-character lowercase hex digest', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const token = mintToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('produces different digests for different tokens', () => {
    expect(hashToken(mintToken())).not.toBe(hashToken(mintToken()))
  })

  it('does not leak the token into its own output', () => {
    const token = mintToken()
    expect(hashToken(token)).not.toContain(token)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/pack-token.test.ts
```

Expected: FAIL — `Cannot find module '../lib/pack-token'`.

- [ ] **Step 3: Implement the token helpers**

Create `products/agent-platform/packages/api/lib/pack-token.ts`:

```typescript
import { randomBytes, createHash } from 'node:crypto';

/**
 * Mint a client-portal token. 32 random bytes rendered base64url is 43
 * characters with no padding — enough entropy that the URL itself is the
 * credential and cannot be enumerated.
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage. Only the digest is ever persisted, so a database
 * read does not hand over every live client portal. Lookup is by digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/pack-token.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Define the tables**

Create `products/agent-platform/packages/schema/handover.ts` (2-space indentation):

```typescript
import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { files } from '@serverless-saas/database/schema/storage';
import { projectPlans } from './pm';
import { clients } from './clients';

export const packStatusEnum = pgEnum('pack_status', ['draft', 'sent', 'signed', 'revoked']);
export const packSectionKindEnum = pgEnum('pack_section_kind', ['delivered', 'credentials', 'training', 'support', 'signoff']);
export const packItemSourceEnum = pgEnum('pack_item_source', ['manual', 'task', 'milestone', 'file']);

// One handover pack per project plan. tokenHash is the sha256 of the portal
// token; the raw token is returned exactly once at send time and never stored.
export const handoverPacks = pgTable('handover_packs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  planId: uuid('plan_id').notNull().references(() => projectPlans.id),
  clientId: uuid('client_id').references(() => clients.id),
  title: text('title').notNull(),
  scopeSummary: text('scope_summary'),
  deliveryDate: timestamp('delivery_date'),
  preparedBy: uuid('prepared_by').notNull().references(() => users.id),
  recipientName: text('recipient_name'),
  recipientEmail: text('recipient_email'),
  status: packStatusEnum('status').notNull().default('draft'),
  tokenHash: text('token_hash'),
  sentAt: timestamp('sent_at'),
  signedAt: timestamp('signed_at'),
  signedByName: text('signed_by_name'),
  signedByEmail: text('signed_by_email'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  tenantStatusIdx: index('handover_packs_tenant_status_idx').on(t.tenantId, t.status),
  tokenHashUniq: uniqueIndex('handover_packs_token_hash_uniq').on(t.tokenHash),
  planLiveUniq: uniqueIndex('handover_packs_plan_live_uniq').on(t.planId).where(sql`deleted_at is null`),
}));

// Five rows per pack, seeded from the template. Each pack owns its sections so
// titles and ordering are editable without affecting any other pack.
export const packSections = pgTable('pack_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  packId: uuid('pack_id').notNull().references(() => handoverPacks.id, { onDelete: 'cascade' }),
  kind: packSectionKindEnum('kind').notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  eyebrow: text('eyebrow'),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: boolean('is_visible').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  packKindUniq: uniqueIndex('pack_sections_pack_kind_uniq').on(t.packId, t.kind),
  packSortIdx: index('pack_sections_pack_sort_idx').on(t.packId, t.sortOrder),
}));

// The records inside a section. sourceType/sourceId record where a row came
// from — a human, or a task/milestone/file in the workspace. sourceId carries
// no foreign key because the referenced table varies by sourceType; this
// follows the precedent set by agent_tasks.milestone_id / plan_id.
export const packItems = pgTable('pack_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  packId: uuid('pack_id').notNull().references(() => handoverPacks.id, { onDelete: 'cascade' }),
  sectionId: uuid('section_id').notNull().references(() => packSections.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  statusLabel: text('status_label'),
  categoryLabel: text('category_label'),
  sourceType: packItemSourceEnum('source_type').notNull().default('manual'),
  sourceId: uuid('source_id'),
  fileId: uuid('file_id').references(() => files.id),
  url: text('url'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  sectionSortIdx: index('pack_items_section_sort_idx').on(t.sectionId, t.sortOrder),
  packIdx: index('pack_items_pack_idx').on(t.packId),
  sourceIdx: index('pack_items_source_idx').on(t.sourceType, t.sourceId),
}));

export type HandoverPack = typeof handoverPacks.$inferSelect;
export type NewHandoverPack = typeof handoverPacks.$inferInsert;
export type PackSection = typeof packSections.$inferSelect;
export type NewPackSection = typeof packSections.$inferInsert;
export type PackItem = typeof packItems.$inferSelect;
export type NewPackItem = typeof packItems.$inferInsert;
```

- [ ] **Step 6: Export it from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add `export * from './handover';` immediately after the `task-revisions` line:

```typescript
export * from './agents';
export * from './clients';
export * from './task-revisions';
export * from './handover';
export * from './conversations';
```

- [ ] **Step 7: Hand-write the migration**

Do **not** run `pnpm db:generate`. Create `packages/foundation/database/migrations/0047_handover_packs.sql` with exactly this content:

```sql
DO $$ BEGIN
 CREATE TYPE "public"."pack_status" AS ENUM('draft', 'sent', 'signed', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pack_section_kind" AS ENUM('delivered', 'credentials', 'training', 'support', 'signoff');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pack_item_source" AS ENUM('manual', 'task', 'milestone', 'file');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handover_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"scope_summary" text,
	"delivery_date" timestamp,
	"prepared_by" uuid NOT NULL,
	"recipient_name" text,
	"recipient_email" text,
	"status" "pack_status" DEFAULT 'draft' NOT NULL,
	"token_hash" text,
	"sent_at" timestamp,
	"signed_at" timestamp,
	"signed_by_name" text,
	"signed_by_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"kind" "pack_section_kind" NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"eyebrow" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status_label" text,
	"category_label" text,
	"source_type" "pack_item_source" DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"file_id" uuid,
	"url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_section_id_pack_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."pack_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handover_packs_tenant_status_idx" ON "handover_packs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_token_hash_uniq" ON "handover_packs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_plan_live_uniq" ON "handover_packs" USING btree ("plan_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_sections_pack_kind_uniq" ON "pack_sections" USING btree ("pack_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_sections_pack_sort_idx" ON "pack_sections" USING btree ("pack_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_section_sort_idx" ON "pack_items" USING btree ("section_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_pack_idx" ON "pack_items" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_source_idx" ON "pack_items" USING btree ("source_type","source_id");
```

Note `handover_packs_token_hash_uniq` is a unique **index**, not a table constraint, so that the many `NULL` values (every draft pack) are permitted — PostgreSQL treats `NULL`s as distinct in unique indexes.

- [ ] **Step 8: Add the journal entry**

Append to `entries` in `packages/foundation/database/migrations/meta/_journal.json` (`0046_task_revisions` is `idx` 45, `when` 1780243500000):

```json
{ "idx": 46, "version": "7", "when": 1780243560000, "tag": "0047_handover_packs", "breakpoints": true }
```

Add no snapshot file.

- [ ] **Step 9: Verify the migration is self-contained**

```bash
cd /Users/suyash/Desktop/projects/project-context
grep -c DROP packages/foundation/database/migrations/0047_handover_packs.sql
grep -oE '"(handover_packs|pack_sections|pack_items|tenants|users|files|project_plans|clients)"' packages/foundation/database/migrations/0047_handover_packs.sql | sort -u
```

Expected: `0` DROPs, and only those eight table names appear.

- [ ] **Step 10: Type-check the workspace**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: passes for every package except `packages/foundation/idempotency`, which fails with `'nx' does not exist` on a Redis call. That failure is pre-existing on this branch — confirm with `git stash` if unsure, and leave it alone.

- [ ] **Step 11: Commit**

```bash
git add products/agent-platform/packages/schema/handover.ts \
        products/agent-platform/packages/schema/index.ts \
        products/agent-platform/packages/api/lib/pack-token.ts \
        products/agent-platform/packages/api/__tests__/pack-token.test.ts \
        packages/foundation/database/migrations/0047_handover_packs.sql \
        packages/foundation/database/migrations/meta/_journal.json
git commit -m "feat(handover): add handover_packs, pack_sections, pack_items and token minting"
```

---

### Task 2: Section template and readiness computation

**Files:**
- Create: `products/agent-platform/packages/api/lib/handover-template.ts`
- Test: `products/agent-platform/packages/api/__tests__/handover-template.test.ts`
- Create: `products/agent-platform/packages/api/lib/handover-readiness.ts`
- Test: `products/agent-platform/packages/api/__tests__/handover-readiness.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. These are pure modules with no imports from the schema package, so they stay testable without mocks.
- Produces: from `../lib/handover-template`: `SectionKind`, `SeedSection`, `SECTION_TEMPLATE: SeedSection[]`, `seedSections(): SeedSection[]`. From `../lib/handover-readiness`: `ReadinessCheck`, `Readiness`, `computeReadiness(pack, sections, items): Readiness`.

- [ ] **Step 1: Write the failing template test**

Create `products/agent-platform/packages/api/__tests__/handover-template.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SECTION_TEMPLATE, seedSections } from '../lib/handover-template'

describe('SECTION_TEMPLATE', () => {
  it('defines the five closeout sections in presentation order', () => {
    expect(SECTION_TEMPLATE.map((s) => s.kind)).toEqual([
      'delivered',
      'credentials',
      'training',
      'support',
      'signoff',
    ])
  })

  it('gives every section a title, subtitle, and eyebrow', () => {
    for (const section of SECTION_TEMPLATE) {
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.subtitle.length).toBeGreaterThan(0)
      expect(section.eyebrow.length).toBeGreaterThan(0)
    }
  })

  it('assigns sortOrder matching array position', () => {
    SECTION_TEMPLATE.forEach((section, i) => {
      expect(section.sortOrder).toBe(i)
    })
  })

  it('hides the credentials section, because credential storage is not built yet', () => {
    const credentials = SECTION_TEMPLATE.find((s) => s.kind === 'credentials')!
    expect(credentials.isVisible).toBe(false)
  })

  it('makes every other section visible', () => {
    for (const section of SECTION_TEMPLATE.filter((s) => s.kind !== 'credentials')) {
      expect(section.isVisible).toBe(true)
    }
  })
})

describe('seedSections', () => {
  it('returns one row per template section', () => {
    expect(seedSections()).toHaveLength(5)
  })

  it('returns a fresh array that callers cannot use to mutate the template', () => {
    const first = seedSections()
    first[0].title = 'Mutated'
    expect(seedSections()[0].title).toBe(SECTION_TEMPLATE[0].title)
    expect(SECTION_TEMPLATE[0].title).not.toBe('Mutated')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover-template.test.ts
```

Expected: FAIL — `Cannot find module '../lib/handover-template'`.

- [ ] **Step 3: Implement the template**

Create `products/agent-platform/packages/api/lib/handover-template.ts`:

```typescript
export type SectionKind = 'delivered' | 'credentials' | 'training' | 'support' | 'signoff';

export interface SeedSection {
  kind: SectionKind;
  title: string;
  subtitle: string;
  eyebrow: string;
  sortOrder: number;
  isVisible: boolean;
}

/**
 * The one built-in closeout template. There is deliberately no template
 * picker — a selector with a single option is worse than no selector. When a
 * template library arrives, it replaces this constant and seedSections() takes
 * a template id; nothing else has to change.
 *
 * credentials ships hidden: the section exists so it needs no migration later,
 * but no credential storage or reveal path is built yet.
 */
export const SECTION_TEMPLATE: readonly SeedSection[] = [
  {
    kind: 'delivered',
    title: 'Delivered items',
    subtitle: 'Everything delivered, grouped by outcome.',
    eyebrow: 'PROJECT CLOSEOUT',
    sortOrder: 0,
    isVisible: true,
  },
  {
    kind: 'credentials',
    title: 'Credentials',
    subtitle: 'Access details stay inside the signed portal.',
    eyebrow: 'SECURE DELIVERY',
    sortOrder: 1,
    isVisible: false,
  },
  {
    kind: 'training',
    title: 'Training materials',
    subtitle: 'Training notes answer the follow-up questions.',
    eyebrow: 'CLIENT SELF-SERVE',
    sortOrder: 2,
    isVisible: true,
  },
  {
    kind: 'support',
    title: 'Support boundary',
    subtitle: 'Support terms are agreed before the project closes.',
    eyebrow: 'SCOPE PROTECTION',
    sortOrder: 3,
    isVisible: true,
  },
  {
    kind: 'signoff',
    title: 'Client sign-off',
    subtitle: 'A signed closeout record both sides can keep.',
    eyebrow: 'FINAL ACCEPTANCE',
    sortOrder: 4,
    isVisible: true,
  },
] as const;

/** Fresh, independently mutable copies of the template rows. */
export function seedSections(): SeedSection[] {
  return SECTION_TEMPLATE.map((section) => ({ ...section }));
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover-template.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing readiness test**

Create `products/agent-platform/packages/api/__tests__/handover-readiness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeReadiness } from '../lib/handover-readiness'

const fullPack = {
  scopeSummary: '5-page Webflow site with CMS blog',
  deliveryDate: new Date('2026-05-22T00:00:00Z'),
  recipientEmail: 'rebecca@bloomstudio.co',
}

const sections = [
  { id: 's1', title: 'Delivered items', isVisible: true },
  { id: 's2', title: 'Credentials', isVisible: false },
  { id: 's3', title: 'Training materials', isVisible: true },
]

const items = [
  { sectionId: 's1' },
  { sectionId: 's3' },
]

describe('computeReadiness', () => {
  it('reports complete when every check passes', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.complete).toBe(r.total)
    expect(r.pct).toBe(100)
    expect(r.checks.every((c) => c.complete)).toBe(true)
  })

  it('produces one check per visible section plus the three pack fields', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.total).toBe(5)
  })

  it('ignores hidden sections entirely', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.checks.map((c) => c.key)).not.toContain('section:s2')
  })

  it('fails the scope check when scopeSummary is blank', () => {
    const r = computeReadiness({ ...fullPack, scopeSummary: '   ' }, sections, items)
    expect(r.checks.find((c) => c.key === 'scopeSummary')!.complete).toBe(false)
    expect(r.complete).toBe(4)
  })

  it('fails the delivery date check when it is null', () => {
    const r = computeReadiness({ ...fullPack, deliveryDate: null }, sections, items)
    expect(r.checks.find((c) => c.key === 'deliveryDate')!.complete).toBe(false)
  })

  it('fails the recipient check when the email is missing', () => {
    const r = computeReadiness({ ...fullPack, recipientEmail: null }, sections, items)
    expect(r.checks.find((c) => c.key === 'recipientEmail')!.complete).toBe(false)
  })

  it('fails a section check when that section has no items', () => {
    const r = computeReadiness(fullPack, sections, [{ sectionId: 's1' }])
    expect(r.checks.find((c) => c.key === 'section:s3')!.complete).toBe(false)
    expect(r.complete).toBe(4)
  })

  it('rounds the percentage to a whole number', () => {
    const r = computeReadiness({ scopeSummary: null, deliveryDate: null, recipientEmail: null }, sections, items)
    expect(r.pct).toBe(40)
    expect(Number.isInteger(r.pct)).toBe(true)
  })

  it('reports 0 percent rather than NaN when there is nothing to check', () => {
    const r = computeReadiness({ scopeSummary: null, deliveryDate: null, recipientEmail: null }, [], [])
    expect(r.pct).toBe(0)
  })

  it('labels every check with human-readable text', () => {
    for (const check of computeReadiness(fullPack, sections, items).checks) {
      expect(check.label.length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover-readiness.test.ts
```

Expected: FAIL — `Cannot find module '../lib/handover-readiness'`.

- [ ] **Step 7: Implement readiness**

Create `products/agent-platform/packages/api/lib/handover-readiness.ts`:

```typescript
export interface ReadinessCheck {
  key: string;
  label: string;
  complete: boolean;
}

export interface Readiness {
  checks: ReadinessCheck[];
  complete: number;
  total: number;
  pct: number;
}

interface ReadinessPack {
  scopeSummary?: string | null;
  deliveryDate?: Date | string | null;
  recipientEmail?: string | null;
}

interface ReadinessSection {
  id: string;
  title: string;
  isVisible: boolean;
}

interface ReadinessItem {
  sectionId: string;
}

function isPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Readiness is derived, never stored. A stored checklist drifts the moment an
 * item is deleted, and reconciling it would be permanent work for no gain.
 *
 * Hidden sections are excluded: an agency that turns a section off should not
 * be blocked by it.
 */
export function computeReadiness(
  pack: ReadinessPack,
  sections: ReadinessSection[],
  items: ReadinessItem[],
): Readiness {
  const populated = new Set(items.map((item) => item.sectionId));

  const checks: ReadinessCheck[] = [
    {
      key: 'scopeSummary',
      label: 'Scope summary written',
      complete: isPresent(pack.scopeSummary),
    },
    {
      key: 'deliveryDate',
      label: 'Delivery date set',
      complete: pack.deliveryDate !== null && pack.deliveryDate !== undefined,
    },
    {
      key: 'recipientEmail',
      label: 'Client email confirmed',
      complete: isPresent(pack.recipientEmail),
    },
    ...sections
      .filter((section) => section.isVisible)
      .map((section) => ({
        key: `section:${section.id}`,
        label: `${section.title} has at least one record`,
        complete: populated.has(section.id),
      })),
  ];

  const total = checks.length;
  const complete = checks.filter((check) => check.complete).length;

  return {
    checks,
    complete,
    total,
    pct: total === 0 ? 0 : Math.round((complete / total) * 100),
  };
}
```

- [ ] **Step 8: Run both suites and confirm they pass**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover-template.test.ts __tests__/handover-readiness.test.ts
```

Expected: PASS — 17 tests total.

- [ ] **Step 9: Commit**

```bash
git add products/agent-platform/packages/api/lib/handover-template.ts \
        products/agent-platform/packages/api/lib/handover-readiness.ts \
        products/agent-platform/packages/api/__tests__/handover-template.test.ts \
        products/agent-platform/packages/api/__tests__/handover-readiness.test.ts
git commit -m "feat(handover): add section template and readiness computation"
```

---

### Task 3: Authenticated pack, section, and item routes

**Files:**
- Create: `products/agent-platform/packages/api/routes/handover.ts`
- Modify: `products/agent-platform/packages/api/index.ts` (add to `mountApiRoutes`)
- Modify: `packages/foundation/database/seeds/permissions.ts`
- Modify: `packages/foundation/database/seeds/role-permissions.ts`

**Interfaces:**
- Consumes: `handoverPacks`, `packSections`, `packItems` from `@serverless-saas/agent-schema/handover` (Task 1); `seedSections` from `../lib/handover-template` and `computeReadiness` from `../lib/handover-readiness` (Task 2); `projectPlans` from `@serverless-saas/agent-schema/pm`.
- Produces: `handoverRoutes` (a `Hono<AppEnv>`) exported from `./routes/handover`, and `assertEditable(pack: { status: string }): string | null`. Endpoints: `POST /handover/packs`, `GET /handover/packs?planId=`, `GET /handover/packs/:packId`, `GET /handover/packs/:packId/readiness`, `PATCH /handover/packs/:packId`, `PATCH /handover/packs/:packId/sections/:sectionId`, `POST|PATCH|DELETE /handover/packs/:packId/items[/:itemId]`.

- [ ] **Step 1: Add the permission resource**

In `packages/foundation/database/seeds/permissions.ts`, add to the `RESOURCES` object immediately after the `project_pages` line:

```typescript
    project_pages: ['create', 'read', 'update', 'delete'],
    handover_packs: ['create', 'read', 'update', 'delete'],
```

In `packages/foundation/database/seeds/role-permissions.ts`, add the four strings to the `admin` role array alongside the existing `project_plans:*` entries:

```typescript
        'handover_packs:create',
        'handover_packs:read',
        'handover_packs:update',
        'handover_packs:delete',
```

Add `'handover_packs:read'` and `'handover_packs:update'` to the `member` role array. Members build packs; only admins create, send, or delete them.

- [ ] **Step 2: Write the routes**

Create `products/agent-platform/packages/api/routes/handover.ts` (4-space indentation, matching `plans.ts`):

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { projectPlans } from '@serverless-saas/agent-schema/pm';
import { hasPermission } from '@serverless-saas/permissions';
import { seedSections } from '../lib/handover-template';
import { computeReadiness } from '../lib/handover-readiness';
import type { AppEnv } from '@serverless-saas/types';

export const handoverRoutes = new Hono<AppEnv>();

/**
 * A signed pack is a record, not a draft. Every mutating handler calls this
 * before touching anything. Enforced here rather than in the UI so that an
 * API client cannot rewrite what a client already put their name to.
 */
export function assertEditable(pack: { status: string }): string | null {
    if (pack.status === 'signed') return 'This pack has been signed and can no longer be edited';
    if (pack.status === 'revoked') return 'This pack has been revoked';
    return null;
}

async function loadPack(packId: string, tenantId: string) {
    const [pack] = await db
        .select()
        .from(handoverPacks)
        .where(and(eq(handoverPacks.id, packId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    return pack ?? null;
}

// POST /handover/packs
handoverRoutes.post('/packs', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        planId: z.string().uuid(),
        title: z.string().min(1).max(200),
        scopeSummary: z.string().max(2000).optional(),
        deliveryDate: z.string().datetime().optional(),
        recipientName: z.string().max(200).optional(),
        recipientEmail: z.string().email().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { planId, title, scopeSummary, deliveryDate, recipientName, recipientEmail } = result.data;

    const [plan] = await db
        .select({ id: projectPlans.id, clientId: projectPlans.clientId })
        .from(projectPlans)
        .where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt)))
        .limit(1);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const [existing] = await db
        .select({ id: handoverPacks.id })
        .from(handoverPacks)
        .where(and(eq(handoverPacks.planId, planId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    if (existing) return c.json({ error: 'This project already has a handover pack', code: 'PACK_EXISTS' }, 409);

    const [pack] = await db.insert(handoverPacks).values({
        tenantId,
        planId,
        clientId: plan.clientId,
        title,
        scopeSummary: scopeSummary ?? null,
        deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
        recipientName: recipientName ?? null,
        recipientEmail: recipientEmail ?? null,
        preparedBy: userId,
        status: 'draft',
    }).returning();

    await db.insert(packSections).values(
        seedSections().map((section) => ({ ...section, tenantId, packId: pack.id })),
    );

    return c.json({ data: pack }, 201);
});

// GET /handover/packs/:packId
handoverRoutes.get('/packs/:packId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);

    const sections = await db.select().from(packSections)
        .where(eq(packSections.packId, pack.id))
        .orderBy(asc(packSections.sortOrder));
    const items = await db.select().from(packItems)
        .where(eq(packItems.packId, pack.id))
        .orderBy(asc(packItems.sortOrder));

    // tokenHash is a stored secret digest and never leaves the server.
    const { tokenHash, ...safePack } = pack;
    return c.json({ data: { pack: safePack, sections, items } });
});

// GET /handover/packs/:packId/readiness
handoverRoutes.get('/packs/:packId/readiness', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);

    const sections = await db.select().from(packSections).where(eq(packSections.packId, pack.id));
    const items = await db.select({ sectionId: packItems.sectionId }).from(packItems).where(eq(packItems.packId, pack.id));

    return c.json({ data: computeReadiness(pack, sections, items) });
});

// PATCH /handover/packs/:packId
handoverRoutes.patch('/packs/:packId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        scopeSummary: z.string().max(2000).nullable().optional(),
        deliveryDate: z.string().datetime().nullable().optional(),
        recipientName: z.string().max(200).nullable().optional(),
        recipientEmail: z.string().email().nullable().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const { deliveryDate, ...rest } = result.data;
    const [updated] = await db.update(handoverPacks)
        .set({
            ...rest,
            ...(deliveryDate !== undefined ? { deliveryDate: deliveryDate ? new Date(deliveryDate) : null } : {}),
            updatedAt: new Date(),
        })
        .where(and(eq(handoverPacks.id, pack.id), eq(handoverPacks.tenantId, tenantId)))
        .returning();

    const { tokenHash, ...safePack } = updated;
    return c.json({ data: safePack });
});

// PATCH /handover/packs/:packId/sections/:sectionId
handoverRoutes.patch('/packs/:packId/sections/:sectionId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        subtitle: z.string().max(500).nullable().optional(),
        eyebrow: z.string().max(100).nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
        isVisible: z.boolean().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [updated] = await db.update(packSections)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(eq(packSections.id, c.req.param('sectionId')), eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)))
        .returning();
    if (!updated) return c.json({ error: 'Section not found' }, 404);

    return c.json({ data: updated });
});

// POST /handover/packs/:packId/items
handoverRoutes.post('/packs/:packId/items', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        sectionId: z.string().uuid(),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        statusLabel: z.string().max(50).optional(),
        categoryLabel: z.string().max(50).optional(),
        sourceType: z.enum(['manual', 'task', 'milestone', 'file']).optional(),
        sourceId: z.string().uuid().optional(),
        fileId: z.string().uuid().optional(),
        url: z.string().url().optional(),
        sortOrder: z.number().int().min(0).optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [section] = await db.select({ id: packSections.id }).from(packSections)
        .where(and(eq(packSections.id, result.data.sectionId), eq(packSections.packId, pack.id)))
        .limit(1);
    if (!section) return c.json({ error: 'Section not found' }, 404);

    const [item] = await db.insert(packItems).values({
        ...result.data,
        tenantId,
        packId: pack.id,
        sourceType: result.data.sourceType ?? 'manual',
    }).returning();

    return c.json({ data: item }, 201);
});

// PATCH /handover/packs/:packId/items/:itemId
handoverRoutes.patch('/packs/:packId/items/:itemId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        statusLabel: z.string().max(50).nullable().optional(),
        categoryLabel: z.string().max(50).nullable().optional(),
        url: z.string().url().nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [updated] = await db.update(packItems)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(eq(packItems.id, c.req.param('itemId')), eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)))
        .returning();
    if (!updated) return c.json({ error: 'Item not found' }, 404);

    return c.json({ data: updated });
});

// DELETE /handover/packs/:packId/items/:itemId
handoverRoutes.delete('/packs/:packId/items/:itemId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const deleted = await db.delete(packItems)
        .where(and(eq(packItems.id, c.req.param('itemId')), eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)))
        .returning({ id: packItems.id });
    if (deleted.length === 0) return c.json({ error: 'Item not found' }, 404);

    return c.json({ data: { id: deleted[0].id } });
});

// GET /handover/packs?planId=... — resolve the pack for a project.
// The builder page needs this: plan_id is unique among live packs, so a
// project has zero or one pack, and the UI must be able to tell which
// without attempting a create.
handoverRoutes.get('/packs', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const planId = c.req.query('planId');
    if (!planId) return c.json({ error: 'planId is required' }, 400);

    const [pack] = await db.select().from(handoverPacks)
        .where(and(eq(handoverPacks.planId, planId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);

    if (!pack) return c.json({ data: null });

    const { tokenHash, ...safePack } = pack;
    return c.json({ data: safePack });
});
```

Register `GET /packs` **after** `GET /packs/:packId` as written above — Hono matches in registration order, and a literal path registered second still wins over a param only if the param route does not match first. Keeping the order shown (`:packId` handlers first, then the query-based lookup last) is safe because `/packs` has no path segment to bind to `:packId`.

- [ ] **Step 3: Mount the router**

In `products/agent-platform/packages/api/index.ts`, add the import at the top alongside the other route imports:

```typescript
import { handoverRoutes } from './routes/handover';
```

and inside `mountApiRoutes`, after the `api.route('/plans', plansRoutes);` line:

```typescript
    api.route('/handover', handoverRoutes);
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: passes for every package except the pre-existing `packages/foundation/idempotency` failure.

- [ ] **Step 5: Run the full package suite**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
```

Expected: PASS — all suites, including the earlier `pack-token`, `handover-template`, and `handover-readiness` tests.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/routes/handover.ts \
        products/agent-platform/packages/api/index.ts \
        packages/foundation/database/seeds/permissions.ts \
        packages/foundation/database/seeds/role-permissions.ts
git commit -m "feat(handover): add authenticated pack, section, and item routes"
```

---

### Task 4: Send, revoke, and the public portal API

**Files:**
- Create: `products/agent-platform/packages/api/routes/handover.lifecycle.ts`
- Create: `products/agent-platform/packages/api/routes/packs.public.ts`
- Test: `products/agent-platform/packages/api/__tests__/handover.public.test.ts`
- Modify: `products/agent-platform/packages/api/routes/handover.ts` (mount lifecycle handlers)
- Modify: `products/agent-platform/packages/api/index.ts` (add to `mountPublicRoutes`)

**Interfaces:**
- Consumes: `mintToken`, `hashToken` from `../lib/pack-token` (Task 1); `computeReadiness` from `../lib/handover-readiness` (Task 2); `handoverRoutes` from `./handover` (Task 3) to mount onto; `publishToQueue` from `@serverless-saas/queue`. It does **not** use `assertEditable` — send and revoke have their own status rules (send is legal on a `sent` pack, re-minting the token; revoke is legal on any unsigned pack).
- Produces: `handoverLifecycleRoutes`, `publicPackRoutes`, and `toPublicProjection(pack, sections, items)` exported from `./packs.public` for testing.

- [ ] **Step 1: Write the failing test for the public projection**

Create `products/agent-platform/packages/api/__tests__/handover.public.test.ts`. `vi.mock` is hoisted above the imports so no real database or workspace package loads:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/handover', () => ({
  handoverPacks: {}, packSections: {}, packItems: {},
}))
vi.mock('@serverless-saas/agent-schema/pm', () => ({ projectPlans: {} }))
vi.mock('@serverless-saas/database/schema/tenancy', () => ({ tenants: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))

import { toPublicProjection } from '../routes/packs.public'

const pack = {
  id: 'pack-1',
  tenantId: 'tenant-1',
  planId: 'plan-1',
  clientId: 'client-1',
  title: 'Bloom Studio Redesign',
  scopeSummary: '5-page Webflow site',
  deliveryDate: new Date('2026-05-22T00:00:00Z'),
  preparedBy: 'user-1',
  recipientName: 'Rebecca Chen',
  recipientEmail: 'rebecca@bloomstudio.co',
  status: 'sent',
  tokenHash: 'a'.repeat(64),
  signedAt: null,
  signedByName: null,
  signedByEmail: null,
}

const sections = [
  { id: 's1', packId: 'pack-1', tenantId: 'tenant-1', kind: 'delivered', title: 'Delivered items', subtitle: 'x', eyebrow: 'Y', sortOrder: 0, isVisible: true },
  { id: 's2', packId: 'pack-1', tenantId: 'tenant-1', kind: 'credentials', title: 'Credentials', subtitle: 'x', eyebrow: 'Y', sortOrder: 1, isVisible: false },
]

const items = [
  { id: 'i1', sectionId: 's1', packId: 'pack-1', tenantId: 'tenant-1', title: 'CMS collections', description: 'd', statusLabel: 'Complete', categoryLabel: 'Delivered', sourceType: 'task', sourceId: 'task-99', fileId: null, url: null, sortOrder: 0 },
  { id: 'i2', sectionId: 's2', packId: 'pack-1', tenantId: 'tenant-1', title: 'Webflow login', description: 'd', statusLabel: 'Secure', categoryLabel: 'Encrypted', sourceType: 'manual', sourceId: null, fileId: null, url: null, sortOrder: 0 },
]

describe('toPublicProjection', () => {
  const result = toPublicProjection(pack, sections, items)
  const serialized = JSON.stringify(result)

  it('never exposes the token hash', () => {
    expect(serialized).not.toContain('a'.repeat(64))
    expect(serialized).not.toContain('tokenHash')
  })

  it('never exposes tenant, plan, client, or preparer ids', () => {
    expect(serialized).not.toContain('tenant-1')
    expect(serialized).not.toContain('plan-1')
    expect(serialized).not.toContain('client-1')
    expect(serialized).not.toContain('user-1')
  })

  it('never exposes workspace provenance', () => {
    expect(serialized).not.toContain('task-99')
    expect(serialized).not.toContain('sourceId')
    expect(serialized).not.toContain('sourceType')
  })

  it('never exposes the recipient email', () => {
    expect(serialized).not.toContain('rebecca@bloomstudio.co')
  })

  it('omits hidden sections and their items', () => {
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].kind).toBe('delivered')
    expect(serialized).not.toContain('Webflow login')
  })

  it('keeps the client-facing content', () => {
    expect(result.title).toBe('Bloom Studio Redesign')
    expect(result.sections[0].items[0].title).toBe('CMS collections')
    expect(result.sections[0].items[0].statusLabel).toBe('Complete')
    expect(result.sections[0].items[0].categoryLabel).toBe('Delivered')
  })

  it('reports whether the pack has been signed', () => {
    expect(result.status).toBe('sent')
    expect(result.signedAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover.public.test.ts
```

Expected: FAIL — `Cannot find module '../routes/packs.public'`.

- [ ] **Step 3: Implement the public router**

Create `products/agent-platform/packages/api/routes/packs.public.ts` (4-space indentation):

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, asc, isNull, inArray } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { hashToken } from '../lib/pack-token';
import type { AppEnv } from '@serverless-saas/types';

export const publicPackRoutes = new Hono<AppEnv>();

/**
 * Build the client-facing view of a pack.
 *
 * This is a whitelist, not the internal row with a few fields deleted. Adding
 * a column to handover_packs must never silently publish it. Everything the
 * client does not need — tenant/plan/client/user ids, the token digest, the
 * recipient address, and all workspace provenance — is left out by
 * construction, and the accompanying test asserts their absence.
 */
export function toPublicProjection(
    pack: Record<string, any>,
    sections: Record<string, any>[],
    items: Record<string, any>[],
) {
    const visible = sections.filter((section) => section.isVisible);

    return {
        title: pack.title as string,
        scopeSummary: (pack.scopeSummary ?? null) as string | null,
        deliveryDate: (pack.deliveryDate ?? null) as Date | null,
        status: pack.status as string,
        signedAt: (pack.signedAt ?? null) as Date | null,
        signedByName: (pack.signedByName ?? null) as string | null,
        sections: visible
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((section) => ({
                kind: section.kind as string,
                title: section.title as string,
                subtitle: (section.subtitle ?? null) as string | null,
                eyebrow: (section.eyebrow ?? null) as string | null,
                items: items
                    .filter((item) => item.sectionId === section.id)
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((item) => ({
                        title: item.title as string,
                        description: (item.description ?? null) as string | null,
                        statusLabel: (item.statusLabel ?? null) as string | null,
                        categoryLabel: (item.categoryLabel ?? null) as string | null,
                        url: (item.url ?? null) as string | null,
                    })),
            })),
    };
}

/**
 * Resolve a pack by its portal token. Returns null for anything the caller is
 * not entitled to see — wrong token, draft, revoked, or deleted — so every
 * failure produces an identical 404 and the response cannot be used to probe
 * for pack existence.
 */
async function resolveByToken(token: string) {
    if (typeof token !== 'string' || token.length !== 43) return null;

    const [pack] = await db
        .select()
        .from(handoverPacks)
        .where(and(eq(handoverPacks.tokenHash, hashToken(token)), isNull(handoverPacks.deletedAt)))
        .limit(1);

    if (!pack) return null;
    if (pack.status !== 'sent' && pack.status !== 'signed') return null;
    return pack;
}

// GET /packs/:token
publicPackRoutes.get('/:token', async (c) => {
    const pack = await resolveByToken(c.req.param('token'));
    if (!pack) return c.json({ error: 'Not found' }, 404);

    const sections = await db.select().from(packSections)
        .where(eq(packSections.packId, pack.id))
        .orderBy(asc(packSections.sortOrder));
    const visibleIds = sections.filter((s) => s.isVisible).map((s) => s.id);
    const items = visibleIds.length === 0 ? [] : await db.select().from(packItems)
        .where(inArray(packItems.sectionId, visibleIds))
        .orderBy(asc(packItems.sortOrder));

    return c.json({ data: toPublicProjection(pack, sections, items) });
});

// POST /packs/:token/sign
publicPackRoutes.post('/:token/sign', async (c) => {
    const result = z.object({
        name: z.string().min(1).max(200),
        email: z.string().email(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await resolveByToken(c.req.param('token'));
    if (!pack) return c.json({ error: 'Not found' }, 404);
    if (pack.status === 'signed') return c.json({ error: 'This pack has already been signed', code: 'ALREADY_SIGNED' }, 409);

    await db.update(handoverPacks)
        .set({
            status: 'signed',
            signedAt: new Date(),
            signedByName: result.data.name,
            signedByEmail: result.data.email,
            updatedAt: new Date(),
        })
        .where(eq(handoverPacks.id, pack.id));

    return c.json({ data: { status: 'signed' } });
});
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/handover.public.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Implement send and revoke**

Create `products/agent-platform/packages/api/routes/handover.lifecycle.ts` (4-space indentation):

```typescript
import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { hasPermission } from '@serverless-saas/permissions';
import { publishToQueue } from '@serverless-saas/queue';
import { mintToken, hashToken } from '../lib/pack-token';
import { computeReadiness } from '../lib/handover-readiness';
import type { AppEnv } from '@serverless-saas/types';

export const handoverLifecycleRoutes = new Hono<AppEnv>();

function portalUrl(token: string): string {
    const root = process.env.NEXT_PUBLIC_APP_URL ?? 'https://projectcontext.co';
    return `${root.replace(/\/$/, '')}/p/${token}`;
}

// POST /handover/packs/:packId/send
handoverLifecycleRoutes.post('/packs/:packId/send', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const packId = c.req.param('packId');
    const [pack] = await db.select().from(handoverPacks)
        .where(and(eq(handoverPacks.id, packId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    if (pack.status === 'signed') return c.json({ error: 'This pack has been signed and can no longer be sent', code: 'PACK_LOCKED' }, 409);

    const sections = await db.select().from(packSections).where(eq(packSections.packId, pack.id));
    const items = await db.select({ sectionId: packItems.sectionId }).from(packItems).where(eq(packItems.packId, pack.id));
    const readiness = computeReadiness(pack, sections, items);
    if (readiness.complete < readiness.total) {
        return c.json({ error: 'Pack is not ready to send', code: 'NOT_READY', details: readiness }, 422);
    }

    // A fresh token on every send invalidates any previously shared link.
    const token = mintToken();
    await db.update(handoverPacks)
        .set({ status: 'sent', tokenHash: hashToken(token), sentAt: new Date(), updatedAt: new Date() })
        .where(and(eq(handoverPacks.id, pack.id), eq(handoverPacks.tenantId, tenantId)));

    const url = portalUrl(token);

    try {
        await publishToQueue({
            type: 'email.send',
            payload: {
                tenantId,
                to: pack.recipientEmail,
                subject: `${pack.title} — project handover`,
                body: `Your handover pack is ready.\n\n${url}\n\nThis link is private. Please do not forward it.`,
            },
        } as any);
    } catch (err) {
        // The link is already valid; a failed email must not lose it.
        console.error('Handover email dispatch failed (non-fatal):', err);
    }

    // The only time the raw token is ever returned.
    return c.json({ data: { url, sentAt: new Date().toISOString() } });
});

// POST /handover/packs/:packId/revoke
handoverLifecycleRoutes.post('/packs/:packId/revoke', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const [updated] = await db.update(handoverPacks)
        .set({ status: 'revoked', tokenHash: null, updatedAt: new Date() })
        .where(and(
            eq(handoverPacks.id, c.req.param('packId')),
            eq(handoverPacks.tenantId, tenantId),
            isNull(handoverPacks.deletedAt),
        ))
        .returning({ id: handoverPacks.id, status: handoverPacks.status });
    if (!updated) return c.json({ error: 'Pack not found' }, 404);

    return c.json({ data: updated });
});
```

Clearing `tokenHash` on revoke means the old link cannot resolve even if the status check were later changed.

- [ ] **Step 6: Mount both routers**

In `products/agent-platform/packages/api/routes/handover.ts`, add the import at the top:

```typescript
import { handoverLifecycleRoutes } from './handover.lifecycle';
```

and at the bottom of the file:

```typescript
handoverRoutes.route('/', handoverLifecycleRoutes);
```

In `products/agent-platform/packages/api/index.ts`, add the import:

```typescript
import { publicPackRoutes } from './routes/packs.public';
```

and inside `mountPublicRoutes`:

```typescript
export function mountPublicRoutes(publicApi: Hono<AppEnv>): void {
    publicApi.route('/widget', widgetRoutes);
    publicApi.route('/packs', publicPackRoutes);
}
```

- [ ] **Step 7: Run the full suite and type-check**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
cd /Users/suyash/Desktop/projects/project-context && pnpm type-check
```

Expected: all tests PASS; type-check passes except the pre-existing `idempotency` failure.

- [ ] **Step 8: Commit**

```bash
git add products/agent-platform/packages/api/routes/handover.lifecycle.ts \
        products/agent-platform/packages/api/routes/packs.public.ts \
        products/agent-platform/packages/api/routes/handover.ts \
        products/agent-platform/packages/api/index.ts \
        products/agent-platform/packages/api/__tests__/handover.public.test.ts
git commit -m "feat(handover): add send, revoke, and the tokenised client portal API"
```

---

### Task 5: Builder UI

**Files:**
- Create: `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/page.tsx`
- Create: `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/_types.ts`
- Create: `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/ReadinessChecklist.tsx`
- Create: `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/SectionRail.tsx`
- Create: `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/ItemEditor.tsx`

**Interfaces:**
- Consumes: the `/handover/*` endpoints from Tasks 3 and 4 via `api` from `@/lib/api`.
- Produces: no exported symbols outside this directory.

- [ ] **Step 1: Define the shared types**

Create `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/_types.ts`:

```typescript
export type SectionKind = 'delivered' | 'credentials' | 'training' | 'support' | 'signoff';

export interface Pack {
  id: string;
  title: string;
  scopeSummary: string | null;
  deliveryDate: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  status: 'draft' | 'sent' | 'signed' | 'revoked';
  sentAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
}

export interface Section {
  id: string;
  kind: SectionKind;
  title: string;
  subtitle: string | null;
  eyebrow: string | null;
  sortOrder: number;
  isVisible: boolean;
}

export interface Item {
  id: string;
  sectionId: string;
  title: string;
  description: string | null;
  statusLabel: string | null;
  categoryLabel: string | null;
  url: string | null;
  sortOrder: number;
}

export interface ReadinessCheck {
  key: string;
  label: string;
  complete: boolean;
}

export interface Readiness {
  checks: ReadinessCheck[];
  complete: number;
  total: number;
  pct: number;
}
```

- [ ] **Step 2: Build the readiness checklist**

Create `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/ReadinessChecklist.tsx`:

```tsx
'use client';

import { Check } from 'lucide-react';
import type { Readiness } from './_types';

export function ReadinessChecklist({ readiness }: { readiness: Readiness }) {
    return (
        <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Checklist — {readiness.complete} of {readiness.total} complete
                </span>
                <span className="text-sm font-semibold text-amber-500">{readiness.pct}%</span>
            </div>
            <ul className="space-y-2">
                {readiness.checks.map((check) => (
                    <li
                        key={check.key}
                        className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-2.5"
                    >
                        <span
                            className={
                                check.complete
                                    ? 'flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500'
                                    : 'h-5 w-5 rounded-full border border-border'
                            }
                        >
                            {check.complete ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className={check.complete ? 'text-sm' : 'text-sm text-muted-foreground'}>
                            {check.label}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
```

- [ ] **Step 3: Build the section rail**

Create `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/SectionRail.tsx`:

```tsx
'use client';

import type { Item, Section } from './_types';

export function SectionRail({
    sections,
    items,
    selectedId,
    onSelect,
}: {
    sections: Section[];
    items: Item[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    return (
        <div className="space-y-3">
            {sections.map((section) => {
                const count = items.filter((item) => item.sectionId === section.id).length;
                const selected = section.id === selectedId;
                return (
                    <button
                        key={section.id}
                        type="button"
                        onClick={() => onSelect(section.id)}
                        className={`w-full rounded-xl border p-4 text-left transition ${
                            selected ? 'border-foreground/40 bg-card' : 'border-border bg-muted/20 hover:bg-muted/40'
                        }`}
                    >
                        <div className="font-medium">{section.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {count} {count === 1 ? 'record' : 'records'}
                            {section.isVisible ? '' : ' · hidden'}
                        </div>
                        <div className="mt-3 h-1 w-full rounded-full bg-border">
                            <div
                                className="h-1 rounded-full bg-amber-500/70"
                                style={{ width: count === 0 ? '0%' : `${Math.min(100, count * 20)}%` }}
                            />
                        </div>
                    </button>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 4: Build the item editor**

Create `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/ItemEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Item, Section } from './_types';

export function ItemEditor({
    section,
    items,
    readOnly,
    onCreate,
    onDelete,
}: {
    section: Section;
    items: Item[];
    readOnly: boolean;
    onCreate: (input: { title: string; description: string; statusLabel: string; categoryLabel: string }) => Promise<void>;
    onDelete: (itemId: string) => Promise<void>;
}) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [statusLabel, setStatusLabel] = useState('');
    const [categoryLabel, setCategoryLabel] = useState('');
    const [saving, setSaving] = useState(false);

    async function submit() {
        if (!title.trim() || saving) return;
        setSaving(true);
        try {
            await onCreate({ title: title.trim(), description: description.trim(), statusLabel: statusLabel.trim(), categoryLabel: categoryLabel.trim() });
            setTitle('');
            setDescription('');
            setStatusLabel('');
            setCategoryLabel('');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div>
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{section.eyebrow}</p>
            <h2 className="mt-2 text-2xl font-bold">{section.subtitle}</h2>

            <div className="mt-6 space-y-3">
                {items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                        No records yet.
                    </p>
                ) : (
                    items.map((item) => (
                        <div key={item.id} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{item.title}</span>
                                    {item.statusLabel ? (
                                        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{item.statusLabel}</span>
                                    ) : null}
                                    {item.categoryLabel ? (
                                        <span className="ml-auto rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{item.categoryLabel}</span>
                                    ) : null}
                                </div>
                                {item.description ? (
                                    <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                                ) : null}
                            </div>
                            {readOnly ? null : (
                                <button type="button" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.title}`}>
                                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>

            {readOnly ? null : (
                <div className="mt-6 space-y-2 rounded-xl border border-border p-4">
                    <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                    <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
                    <div className="flex gap-2">
                        <Input placeholder="Status label (e.g. Complete)" value={statusLabel} onChange={(e) => setStatusLabel(e.target.value)} />
                        <Input placeholder="Category label (e.g. Delivered)" value={categoryLabel} onChange={(e) => setCategoryLabel(e.target.value)} />
                    </div>
                    <Button onClick={submit} disabled={!title.trim() || saving}>
                        {saving ? 'Adding…' : 'Add record'}
                    </Button>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 5: Build the page**

Create `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/page.tsx`:

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ReadinessChecklist } from './ReadinessChecklist';
import { SectionRail } from './SectionRail';
import { ItemEditor } from './ItemEditor';
import type { Item, Pack, Readiness, Section } from './_types';

export default function HandoverBuilderPage() {
    const { planId } = useParams<{ planId: string }>();

    const [pack, setPack] = useState<Pack | null>(null);
    const [sections, setSections] = useState<Section[]>([]);
    const [items, setItems] = useState<Item[]>([]);
    const [readiness, setReadiness] = useState<Readiness | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [sentUrl, setSentUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const loadPack = useCallback(async (packId: string) => {
        const detail = await api.get<{ data: { pack: Pack; sections: Section[]; items: Item[] } }>(`/handover/packs/${packId}`);
        setPack(detail.data.pack);
        setSections(detail.data.sections);
        setItems(detail.data.items);
        setSelectedId((current) => current ?? detail.data.sections[0]?.id ?? null);
        const r = await api.get<{ data: Readiness }>(`/handover/packs/${packId}/readiness`);
        setReadiness(r.data);
    }, []);

    // Load the existing pack, if there is one. Visiting a page must never
    // create data — the agency creates the pack explicitly.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const existing = await api.get<{ data: Pack | null }>(`/handover/packs?planId=${planId}`);
                if (cancelled) return;
                if (existing.data) await loadPack(existing.data.id);
            } catch (err: any) {
                if (!cancelled) setError(err?.data?.error ?? 'Could not load the handover pack');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [planId, loadPack]);

    async function createPack() {
        setError(null);
        try {
            const created = await api.post<{ data: Pack }>('/handover/packs', {
                planId,
                title: 'Project handover',
            });
            await loadPack(created.data.id);
        } catch (err: any) {
            setError(err?.data?.error ?? 'Could not create the handover pack');
        }
    }

    const selected = sections.find((s) => s.id === selectedId) ?? null;
    const readOnly = pack?.status === 'signed' || pack?.status === 'revoked';

    async function createItem(input: { title: string; description: string; statusLabel: string; categoryLabel: string }) {
        if (!pack || !selected) return;
        await api.post(`/handover/packs/${pack.id}/items`, { sectionId: selected.id, ...input });
        await loadPack(pack.id);
    }

    async function deleteItem(itemId: string) {
        if (!pack) return;
        // The client exposes DELETE as `del`, not `delete` — see apps/web/lib/api.ts.
        await api.del(`/handover/packs/${pack.id}/items/${itemId}`);
        await loadPack(pack.id);
    }

    async function send() {
        if (!pack) return;
        try {
            const res = await api.post<{ data: { url: string } }>(`/handover/packs/${pack.id}/send`, {});
            setSentUrl(res.data.url);
            await loadPack(pack.id);
        } catch (err: any) {
            setError(err?.data?.error ?? 'Could not send the pack');
        }
    }

    if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading handover pack…</div>;
    if (error) return <div className="p-8 text-sm text-destructive">{error}</div>;

    if (!pack) {
        return (
            <div className="p-8">
                <h1 className="text-2xl font-bold">Handover pack</h1>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    This project does not have a handover pack yet. Creating one seeds the five
                    closeout sections, which you can then fill in and send to the client.
                </p>
                <Button className="mt-6" onClick={createPack}>Create handover pack</Button>
            </div>
        );
    }

    return (
        <div className="p-8">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">{pack.title}</h1>
                    <p className="text-sm text-muted-foreground">Status: {pack.status}</p>
                </div>
                <Button onClick={send} disabled={readOnly || !readiness || readiness.complete < readiness.total}>
                    Send to client
                </Button>
            </div>

            {sentUrl ? (
                <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
                    <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Client portal</p>
                    <p className="mt-1 break-all font-mono text-sm">{sentUrl}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Copy this now — it is shown once and cannot be retrieved later.
                    </p>
                </div>
            ) : null}

            {readiness ? <div className="mb-6"><ReadinessChecklist readiness={readiness} /></div> : null}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
                <SectionRail sections={sections} items={items} selectedId={selectedId} onSelect={setSelectedId} />
                <div className="rounded-xl border border-border bg-card p-6">
                    {selected ? (
                        <ItemEditor
                            section={selected}
                            items={items.filter((item) => item.sectionId === selected.id)}
                            readOnly={readOnly}
                            onCreate={createItem}
                            onDelete={deleteItem}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Verify the build compiles**

```bash
cd /Users/suyash/Desktop/projects/project-context/apps/web && pnpm build 2>&1 | tail -20
```

Expected: build succeeds. `@/components/ui/textarea`, `@/components/ui/input`, and `@/components/ui/button` all already exist in `apps/web/components/ui/` — no shadcn additions are needed.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/[tenant]/dashboard/plans/[planId]/handover"
git commit -m "feat(handover): add the pack builder UI"
```

---

### Task 6: Client portal page

**Files:**
- Create: `apps/web/app/p/[token]/page.tsx`
- Create: `apps/web/app/p/[token]/SignOffForm.tsx`

**Interfaces:**
- Consumes: `GET /packs/:token` and `POST /packs/:token/sign` from Task 4.
- Produces: no exported symbols.

- [ ] **Step 1: Build the sign-off form**

Create `apps/web/app/p/[token]/SignOffForm.tsx`:

```tsx
'use client';

import { useState } from 'react';

export function SignOffForm({ token, signedByName }: { token: string; signedByName: string | null }) {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [done, setDone] = useState(Boolean(signedByName));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    if (done) {
        return (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-8 text-center">
                <p className="text-lg font-semibold">Project closed</p>
                <p className="mt-1 text-sm text-muted-foreground">Signed by {signedByName ?? name}</p>
            </div>
        );
    }

    async function submit() {
        if (!name.trim() || !email.trim() || saving) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/portal/${token}/sign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), email: email.trim() }),
            });
            if (!res.ok) throw new Error((await res.json())?.error ?? 'Could not sign');
            setDone(true);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="rounded-xl border border-border p-6">
            <p className="mb-4 text-sm text-muted-foreground">
                Confirm you have received this handover and accept the support terms above.
            </p>
            <div className="space-y-3">
                <input
                    className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
                    placeholder="Your full name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <input
                    className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
                    placeholder="Your email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                />
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <button
                    type="button"
                    onClick={submit}
                    disabled={!name.trim() || !email.trim() || saving}
                    className="w-full rounded-lg bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-500 disabled:opacity-40"
                >
                    {saving ? 'Signing…' : 'Review & sign'}
                </button>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Add the portal proxy route**

The browser cannot call the API host directly without CORS, and `/api/proxy` attaches auth cookies. Create `apps/web/app/api/portal/[token]/sign/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/packs/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await req.text(),
    });
    return NextResponse.json(await res.json(), { status: res.status });
}
```

- [ ] **Step 3: Build the portal page**

Create `apps/web/app/p/[token]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { SignOffForm } from './SignOffForm';

interface PortalItem {
    title: string;
    description: string | null;
    statusLabel: string | null;
    categoryLabel: string | null;
    url: string | null;
}

interface PortalSection {
    kind: string;
    title: string;
    subtitle: string | null;
    eyebrow: string | null;
    items: PortalItem[];
}

interface PortalPack {
    title: string;
    scopeSummary: string | null;
    deliveryDate: string | null;
    status: string;
    signedAt: string | null;
    signedByName: string | null;
    sections: PortalSection[];
}

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;

    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/packs/${token}`, { cache: 'no-store' });
    if (!res.ok) notFound();
    const pack: PortalPack = (await res.json()).data;

    return (
        <div className="min-h-screen bg-background px-6 py-12">
            <div className="mx-auto max-w-3xl">
                <h1 className="text-3xl font-bold">{pack.title}</h1>
                {pack.scopeSummary ? <p className="mt-2 text-muted-foreground">{pack.scopeSummary}</p> : null}

                {pack.sections.map((section) => (
                    <section key={section.kind} className="mt-12">
                        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{section.eyebrow}</p>
                        <h2 className="mt-2 text-2xl font-bold">{section.subtitle ?? section.title}</h2>
                        <div className="mt-6 space-y-3">
                            {section.items.map((item, i) => (
                                <div key={`${section.kind}-${i}`} className="rounded-xl border border-border bg-card px-5 py-4">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{item.title}</span>
                                        {item.statusLabel ? (
                                            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{item.statusLabel}</span>
                                        ) : null}
                                        {item.categoryLabel ? (
                                            <span className="ml-auto rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{item.categoryLabel}</span>
                                        ) : null}
                                    </div>
                                    {item.description ? <p className="mt-1 text-sm text-muted-foreground">{item.description}</p> : null}
                                    {item.url ? (
                                        <a href={item.url} className="mt-2 inline-block text-sm text-amber-500 underline" rel="noreferrer noopener" target="_blank">
                                            Open
                                        </a>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </section>
                ))}

                <div className="mt-12">
                    <SignOffForm token={token} signedByName={pack.signedByName} />
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Confirm the portal is not rewritten by tenant middleware**

`apps/web/middleware.ts` matches `/p/...` (its matcher excludes only `api`, `_next/static`, `_next/image`, `favicon.ico`), but as written it performs **no rewrite or redirect** — it only sets an `x-tenant-slug` request header and calls `NextResponse.next()`. So `/p/[token]` resolves unchanged on the apex domain and on any tenant subdomain, which is what the portal needs.

Confirm this is still true before relying on it:

```bash
grep -n "NextResponse.rewrite\|NextResponse.redirect" apps/web/middleware.ts
```

Expected: no matches. If either appears, add an early `if (url.pathname.startsWith('/p/')) return NextResponse.next();` at the top of `middleware()`.

- [ ] **Step 5: Verify the build compiles**

```bash
cd /Users/suyash/Desktop/projects/project-context/apps/web && pnpm build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/p" "apps/web/app/api/portal"
git commit -m "feat(handover): add the public client portal and sign-off"
```

---

### Task 7: Apply migration 0047

**Files:** none — this task runs a migration.

**Interfaces:**
- Consumes: migration `0047` from Task 1.
- Produces: the three tables live in the database.

- [ ] **Step 1: Confirm the database target**

```bash
cd packages/foundation/database && node -e "require('dotenv').config({path:'../../../apps/api/.env'}); const u=new URL(process.env.DATABASE_URL); console.log(u.host, u.pathname)"
```

As of 2026-08-01 this is Supabase (`aws-0-ap-northeast-1.pooler.supabase.com`, database `postgres`), with migrations `0000`–`0046` already applied. **State the host aloud and confirm with the repository owner before continuing.**

- [ ] **Step 2: Apply**

```bash
cd packages/foundation/database && pnpm db:migrate
```

Expected: one migration applied (`0047_handover_packs`), no errors.

- [ ] **Step 3: Verify the schema landed**

```bash
cd packages/foundation/database && node -e "
require('dotenv').config({path:'../../../apps/api/.env'});
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
(async () => {
  const t = await sql\`select table_name from information_schema.tables
    where table_name in ('handover_packs','pack_sections','pack_items') order by table_name\`;
  console.log('tables:', t.map(r => r.table_name));
  const i = await sql\`select indexname from pg_indexes
    where indexname in ('handover_packs_plan_live_uniq','handover_packs_token_hash_uniq') order by indexname\`;
  console.log('unique indexes:', i.map(r => r.indexname));
  await sql.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```

Expected output:
```
tables: [ 'handover_packs', 'pack_items', 'pack_sections' ]
unique indexes: [ 'handover_packs_plan_live_uniq', 'handover_packs_token_hash_uniq' ]
```

- [ ] **Step 4: Report the result**

State plainly which database was migrated and paste the verification output. If any check failed, say so with the error rather than proceeding.

---

## Notes for the next plan

With the spine landed, the deferred subsystems become tractable:

- **Auto-fill** reads completed `agent_tasks` (with `acceptanceCriteria` and `completedAt`) and `task_revisions` for the plan, and writes `pack_items` with `sourceType: 'task'` and `sourceId`. Nothing in the data model changes.
- **Credentials** un-hides the seeded section, adds an encrypted value column using `packages/foundation/ai/src/utils/encryption.ts`, and hardens the portal with email-code verification before any secret is served.
- **Certificate and PDF** freeze a snapshot at signature, hash it, and render from the worker Lambda or the GCP VM. `signedAt` / `signedByName` already exist to hang it off.
