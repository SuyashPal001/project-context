# Template Recreation-Contract (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six flat prompt-string creative templates with a structured, DB-backed recreation contract (scenes, clone/exclude notes, technical constraints) fetched server-side by a new `retrieve_template` tool, so Director gets real shot-level guidance instead of one free-text sentence.

**Architecture:** New `creative_templates` table (nullable `tenant_id`, global rows for now) in `products/agent-platform/packages/schema`, seeded via an idempotent upsert script. A new Mastra tool `retrieve_template` on both `directorAgent` and `directorAgentDelegate` reads it (same pattern as the existing `fetchPRD` tool — direct `pg` pool, no ORM). The web composer stops sending the full prompt text and sends only the template slug; Director's shared instructions call `retrieve_template` before generating.

**Tech Stack:** Drizzle ORM / PostgreSQL, Mastra (`createTool`), `pg` driver, Next.js/React (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-template-recreation-contract-design.md`

## Revision note (post-review)

This plan was reviewed a second time (Opus) after being written and found three defects that would have stopped execution or shipped a silent bug: a broken `ON CONFLICT` on the seed (nullable-column uniqueness doesn't work the way the first draft assumed), a mocked-pool test that fails as written (missing `.on`, module-memoized pool state bleeding across tests), and a missing test for the spec's own headline blocker (tool registered on `directorAgentDelegate`, not just `directorAgent`). All fixed inline below, marked **[review]**.

## Global Constraints

- `creative_templates.tenant_id` is nullable; every row this plan creates has `tenant_id = NULL` (platform-owned), matching `agentTemplates`'s convention, not `skills.ts`'s.
- No `production_guide` column — cut per the reviewed spec.
- Reference clip column is `reference_file_id` (nullable FK to `files.id`), never a raw URL — populated only in the out-of-scope Phase 2.
- `retrieve_template` is ungated: no `requireApproval`, no credit charge.
- The tool must be registered on **both** `directorAgent` and `directorAgentDelegate` — the live brief path uses the delegate, not the standalone agent.
- `isTemplateSelection` (web) must accept a `template` value whether or not it carries a `prompt` field — historical chat transcripts still have `prompt` and must keep rendering.
- Migration SQL lands in `packages/foundation/database/migrations/` (drizzle-kit's single `out` dir) even though the schema *definition* file lives under `products/agent-platform/packages/schema/`.
- Real reference-clip sourcing, `analyze_video`-driven scene population, and tenant-authored templates are **out of scope** for this plan (Phase 2 of the spec).

---

## Task 1: `creative_templates` schema + migration

**Files:**
- Create: `products/agent-platform/packages/schema/creativeTemplates.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Migration: `packages/foundation/database/migrations/00NN_<generated-name>.sql` (auto-generated, do not hand-write)

**Interfaces:**
- Produces: `creativeTemplates` (Drizzle table), `CreativeTemplate` / `NewCreativeTemplate` types — consumed by Task 2 (seed script) and Task 3 (tool). **[review: corrected task numbers]**

- [ ] **Step 1: Write the schema file**

```typescript
// products/agent-platform/packages/schema/creativeTemplates.ts
import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { files } from '@serverless-saas/database/schema/storage';

// Structured recreation contract for a creative-library template, consumed by
// the retrieve_template Mastra tool on Director. Distinct from agent_templates
// (agents.ts), which is an unrelated system for versioned agent system prompts
// — do not conflate the two tables.
//
// tenant_id is nullable — NULL = platform-owned, following the same
// convention agentTemplates already uses (agents.ts). Every row this ships
// with is platform-owned; tenant-authored templates are explicitly future
// scope, not built here.
export const creativeTemplates = pgTable('creative_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  imageUrl: text('image_url').notNull(),
  // Populated only once Phase 2 (real reference-clip analysis) ships — null
  // for every row this plan creates.
  referenceFileId: uuid('reference_file_id').references(() => files.id),
  clonePrompt: text('clone_prompt').notNull(),
  negativePrompt: text('negative_prompt').notNull(),
  cloneNotes: text('clone_notes').notNull(),
  excludeInClone: text('exclude_in_clone').notNull(),
  // { aspectRatio: string, durationSeconds: number, resolution: string, fps: number }
  technical: jsonb('technical').notNull(),
  // Array<{ order: number, shotType: string, action: string, onScreenText?: string, audio?: string }>
  scenes: jsonb('scenes').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // .nullsNotDistinct() [review, required]: a plain unique() on a nullable
  // column defaults to NULLS DISTINCT in Postgres, meaning two rows with
  // (NULL, 'offer') are NOT a conflict — the seed script's ON CONFLICT
  // (tenant_id, slug) would then never fire for any platform-owned row,
  // silently duplicating all 6 rows on every re-run instead of upserting.
  // nullsNotDistinct() emits PG15+'s UNIQUE NULLS NOT DISTINCT, which makes
  // (NULL, 'offer') collide with itself and ON CONFLICT work as intended.
  tenantSlugUniq: unique().on(t.tenantId, t.slug).nullsNotDistinct(),
}));

export type CreativeTemplate = typeof creativeTemplates.$inferSelect;
export type NewCreativeTemplate = typeof creativeTemplates.$inferInsert;
```

- [ ] **Step 2: Export it from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add (alongside the other `export * from './...'` lines — match the file's existing style; open it first to place this correctly among the alphabetical/grouped exports already there):

```typescript
export * from './creativeTemplates';
```

**[review]** No `.js` extension — every other line in this barrel file is extensionless (`export * from './agents';`), and the plan's own prose says to match that style; a `.js` suffix would be inconsistent even though it still compiles.

- [ ] **Step 3: Confirm the target database is PG15+**

```bash
psql "$DATABASE_URL" -c "SELECT version();"
```

Expected: PostgreSQL 15 or later — required for `nullsNotDistinct()`'s `UNIQUE NULLS NOT DISTINCT` (Supabase's current versions are 15+, but confirm rather than assume).

- [ ] **Step 4: Generate the migration**

Run from `packages/foundation/database`:

```bash
pnpm exec drizzle-kit generate
```

Expected: a new file `packages/foundation/database/migrations/00NN_<name>.sql` containing a `CREATE TABLE "creative_templates" (...)` statement with the columns above, plus `UNIQUE NULLS NOT DISTINCT ("tenant_id","slug")`. Confirm the generated SQL matches — foreign keys to `tenants(id)` and `files(id)`, `NOT NULL` on every column except `tenant_id` and `reference_file_id`, and `NULLS NOT DISTINCT` present on the unique constraint (not just `UNIQUE`).

- [ ] **Step 5: Apply the migration**

```bash
pnpm exec drizzle-kit migrate
```

Expected: no errors; `creative_templates` now exists in the target database. **[review, added]** Task 2's seed script needs this table to exist — `generate` alone only writes the SQL file, it doesn't run it.

- [ ] **Step 6: Type-check**

```bash
cd products/agent-platform/packages/schema && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/schema/creativeTemplates.ts \
        products/agent-platform/packages/schema/index.ts \
        packages/foundation/database/migrations/
git commit -m "feat(schema): add creative_templates table"
```

---

## Task 2: Seed script — 6 hand-authored recreation contracts

**Files:**
- Create: `products/agent-platform/packages/api/seeds/creative-templates.ts`
- Create: `products/agent-platform/packages/api/seeds/creative-templates.test.ts`
- Modify: `products/agent-platform/packages/api/package.json`

**Interfaces:**
- Consumes: `creative_templates` table from Task 1 (raw SQL columns, not the Drizzle export — this seed uses the `postgres` driver directly, same as `agent-templates.ts`).
- Produces: 6 populated rows, `slug` values `problem-solution`, `product-demo`, `testimonial`, `before-after`, `offer`, `ugc-review` — these slugs are consumed by Task 3's tool tests and Task 5's web changes (must match `apps/web/components/platform/chat/creativeLibraryTemplates.ts`'s existing `id` values exactly, since Task 5 repoints those ids at these slugs). **[review: corrected task numbers]**

- [ ] **Step 1: Write the seed script**

```typescript
// products/agent-platform/packages/api/seeds/creative-templates.ts
/**
 * Seeds the six creative-library template recreation contracts.
 *
 * Consumed by the retrieve_template Mastra tool
 * (apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.ts) on Director.
 * Every row here is platform-owned (tenant_id = NULL) — tenant-authored
 * templates are not built yet.
 *
 * Idempotent: safe to re-run after hand-editing a contract below.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:creative-templates
 */

import postgres from 'postgres';

interface TemplateSeed {
  slug: string;
  title: string;
  category: string;
  description: string;
  imageUrl: string;
  clonePrompt: string;
  negativePrompt: string;
  cloneNotes: string;
  excludeInClone: string;
  technical: { aspectRatio: string; durationSeconds: number; resolution: string; fps: number };
  scenes: Array<{ order: number; shotType: string; action: string; onScreenText?: string; audio?: string }>;
}

const TEMPLATES: TemplateSeed[] = [
  {
    slug: 'problem-solution',
    title: 'Problem → Solution',
    category: 'Explainer',
    description: 'Open with a familiar frustration, then show the product fixing it.',
    imageUrl: '/creative/templates/problem-solution.png',
    clonePrompt: 'Open on the audience\'s problem in a relatable everyday moment. Introduce the product as the fix. Demonstrate the specific benefit that solves the problem shown. Close on a clear call to action.',
    negativePrompt: 'No competitor branding, no invented statistics, no unsupported medical or performance claims.',
    cloneNotes: 'Keep the pacing brisk — the frustration beat should read in 2-3 seconds, not linger. The tone shift from "problem" to "relief" is the emotional core; preserve that contrast.',
    excludeInClone: 'Any reference to a specific competitor product or brand. Do not carry over source-clip watermarks, UI chrome, or identifiable people from a reference.',
    technical: { aspectRatio: '9:16', durationSeconds: 20, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'medium close-up', action: 'Subject visibly frustrated by the problem in a natural setting.', onScreenText: undefined, audio: 'Relatable, slightly exasperated tone.' },
      { order: 2, shotType: 'product insert', action: 'Product is introduced — clean reveal, no fanfare.', onScreenText: 'The fix.', audio: 'Tone shifts to relief/curiosity.' },
      { order: 3, shotType: 'demonstration', action: 'Product used to directly resolve the problem shown in scene 1.', onScreenText: undefined, audio: 'Confident, upbeat.' },
      { order: 4, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Try it today.', audio: 'Warm, direct.' },
    ],
  },
  {
    slug: 'product-demo',
    title: 'Product Demo',
    category: 'Demonstration',
    description: 'Show the product in use and make its main benefit obvious.',
    imageUrl: '/creative/templates/product-demo.png',
    clonePrompt: 'Show the product in active use. Focus the entire piece on one clear, single benefit — do not try to cover multiple features. Close with a call to action.',
    negativePrompt: 'No competitor branding, no multi-feature laundry list, no invented pricing or claims.',
    cloneNotes: 'One benefit only. The demonstration shot should be the longest scene — this is a show-don\'t-tell structure, minimize narration over the demo itself.',
    excludeInClone: 'Any competitor product visible in-frame. Do not carry over a reference clip\'s original branding or identifiable presenter.',
    technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'establishing', action: 'Product introduced in its natural use context.', onScreenText: undefined, audio: 'Neutral, inviting.' },
      { order: 2, shotType: 'demonstration', action: 'Product used, single benefit made visually obvious.', onScreenText: undefined, audio: 'Confident narration on the one benefit only.' },
      { order: 3, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Get yours.', audio: 'Direct, brief.' },
    ],
  },
  {
    slug: 'testimonial',
    title: 'Testimonial',
    category: 'Social proof',
    description: 'Tell a customer story with a specific before and after.',
    imageUrl: '/creative/templates/testimonial.png',
    clonePrompt: 'Tell a believable customer story with a specific before-and-after. Do not invent customer quotes or results — ask for real ones before generating narration that states a result.',
    negativePrompt: 'No invented customer names, quotes, or numeric results. No claim of a "real" testimonial unless the user has actually supplied one.',
    cloneNotes: 'Authenticity over polish — slightly imperfect, conversational delivery reads as more credible than a scripted-sounding read.',
    excludeInClone: 'A reference clip\'s actual customer identity or quote — these must be replaced with the client\'s own, or left as clearly-marked placeholders pending real input.',
    technical: { aspectRatio: '9:16', durationSeconds: 25, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'talking head', action: 'Presenter describes life before the product, specific and personal.', onScreenText: undefined, audio: 'Conversational, unpolished.' },
      { order: 2, shotType: 'product insert', action: 'Product shown as the turning point.', onScreenText: undefined, audio: 'Tone lifts.' },
      { order: 3, shotType: 'talking head', action: 'Presenter describes the specific after-state.', onScreenText: undefined, audio: 'Warmer, more confident.' },
      { order: 4, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'See for yourself.', audio: 'Direct.' },
    ],
  },
  {
    slug: 'before-after',
    title: 'Before → After',
    category: 'Transformation',
    description: 'Contrast the old experience with the improved one.',
    imageUrl: '/creative/templates/before-after.png',
    clonePrompt: 'Contrast the experience before using the product against the experience after. Avoid unsupported performance claims — show the contrast visually rather than asserting numbers.',
    negativePrompt: 'No invented percentages, timeframes, or measurable claims not supplied by the user.',
    cloneNotes: 'The cut between "before" and "after" is the entire structure — keep it a hard, clean cut, not a slow transition, so the contrast reads instantly.',
    excludeInClone: 'Any competitor product shown as the "before" state. Do not carry over identifiable people from a reference clip.',
    technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'wide', action: 'The "before" state — visually establishes the problem/limitation.', onScreenText: 'Before', audio: 'Flat, unremarkable tone.' },
      { order: 2, shotType: 'hard cut, matching wide', action: 'The "after" state — same framing, product now in use.', onScreenText: 'After', audio: 'Sharp tonal lift on the cut.' },
      { order: 3, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Make the switch.', audio: 'Confident.' },
    ],
  },
  {
    slug: 'offer',
    title: 'Offer / Sale',
    category: 'Promotion',
    description: 'Lead with an offer and explain why it is worth acting on.',
    imageUrl: '/creative/templates/offer.png',
    clonePrompt: 'Lead with the offer itself. Explain the value in one beat. Close with a call to action and a deadline. Ask for the actual price, discount, and deadline instead of inventing them.',
    negativePrompt: 'No invented price, discount percentage, or deadline. No false urgency not supplied by the user.',
    cloneNotes: 'Offer comes first, not last — this inverts the usual "build up to the ask" structure deliberately.',
    excludeInClone: 'Any pricing or deadline copied from a reference clip — these are always client-specific and must never be reused.',
    technical: { aspectRatio: '9:16', durationSeconds: 12, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'product hero', action: 'Product shown immediately with the offer stated on-screen.', onScreenText: '[OFFER PLACEHOLDER]', audio: 'High-energy open.' },
      { order: 2, shotType: 'product insert', action: 'Brief value explanation — why the offer matters.', onScreenText: undefined, audio: 'Direct, persuasive.' },
      { order: 3, shotType: 'closing card', action: 'Offer restated with deadline and call to action.', onScreenText: '[DEADLINE PLACEHOLDER] — Shop now.', audio: 'Urgent but not invented.' },
    ],
  },
  {
    slug: 'ugc-review',
    title: 'UGC Review',
    category: 'Social video',
    description: 'A casual first-person walkthrough suited to short social clips.',
    imageUrl: '/creative/templates/ugc-review.png',
    clonePrompt: 'Use a casual, first-person hook, then walk through the product experience, land on one specific benefit, and close with a natural (not scripted-sounding) call to action. Do not claim this is a real customer review unless the user has provided one.',
    negativePrompt: 'No claim of being a "real" review without user-supplied source material. No invented reviewer identity.',
    cloneNotes: 'The hook must land in the first second — this is a scroll-stopping format, not a slow build. Handheld, imperfect camera energy is intentional, not a flaw to fix.',
    excludeInClone: 'A reference clip\'s actual creator identity, platform watermark, or username overlay.',
    technical: { aspectRatio: '9:16', durationSeconds: 20, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'selfie-style hook', action: 'Casual, attention-grabbing opening line direct to camera.', onScreenText: undefined, audio: 'Energetic, informal.' },
      { order: 2, shotType: 'handheld demonstration', action: 'Product used in a natural, unstaged-feeling way.', onScreenText: undefined, audio: 'Conversational narration.' },
      { order: 3, shotType: 'selfie-style close', action: 'Direct-to-camera close with the one specific benefit and a natural call to action.', onScreenText: undefined, audio: 'Casual, sincere.' },
    ],
  },
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    for (const t of TEMPLATES) {
      await sql`
        INSERT INTO creative_templates (
          tenant_id, slug, title, category, description, image_url,
          clone_prompt, negative_prompt, clone_notes, exclude_in_clone,
          technical, scenes, status
        ) VALUES (
          NULL, ${t.slug}, ${t.title}, ${t.category}, ${t.description}, ${t.imageUrl},
          ${t.clonePrompt}, ${t.negativePrompt}, ${t.cloneNotes}, ${t.excludeInClone},
          ${sql.json(t.technical)}, ${sql.json(t.scenes)}, 'active'
        )
        ON CONFLICT (tenant_id, slug) DO UPDATE SET
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          description = EXCLUDED.description,
          image_url = EXCLUDED.image_url,
          clone_prompt = EXCLUDED.clone_prompt,
          negative_prompt = EXCLUDED.negative_prompt,
          clone_notes = EXCLUDED.clone_notes,
          exclude_in_clone = EXCLUDED.exclude_in_clone,
          technical = EXCLUDED.technical,
          scenes = EXCLUDED.scenes,
          updated_at = now()
      `;
      console.log(`[seed:creative-templates] upserted ${t.slug}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:creative-templates] failed', err);
  process.exit(1);
});
```

**[review]** `ON CONFLICT (tenant_id, slug)` is correctly matched against Task 1's `.nullsNotDistinct()` constraint — this is what makes `(NULL, 'offer')` collide with itself so the upsert fires instead of silently inserting a duplicate row on every re-run. If Task 1's constraint were a plain `unique()` (NULLS DISTINCT, Postgres's default), this `ON CONFLICT` clause would never trigger for any of these platform-owned rows, and Step 3 below would show row counts growing on every re-run with no error. Do not build this seed against Task 1's schema without confirming `.nullsNotDistinct()` made it into the applied migration.

- [ ] **Step 2: Export `TEMPLATES` and add a shape test**

**[review, added]** The spec's Testing section asked for "a test asserts every row parses against the expected shape (non-empty `scenes` array, valid `technical` keys)." The first draft of this plan only covered that with a manual `psql` eyeball in Final Verification — weaker than asked and not repeatable in CI. Fixed here as a pure unit test against the static `TEMPLATES` array (no DB needed, so it runs everywhere the DB-dependent Step 3 below can't).

In `products/agent-platform/packages/api/seeds/creative-templates.ts`, change `const TEMPLATES: TemplateSeed[] = [` to `export const TEMPLATES: TemplateSeed[] = [` and `interface TemplateSeed {` to `export interface TemplateSeed {` (two one-word additions, no other change to the file).

Create `products/agent-platform/packages/api/seeds/creative-templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { TEMPLATES } from './creative-templates'

describe('creative template seed data', () => {
  it('has exactly the 6 expected slugs', () => {
    expect(TEMPLATES.map(t => t.slug).sort()).toEqual([
      'before-after', 'offer', 'problem-solution', 'product-demo', 'testimonial', 'ugc-review',
    ])
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has a non-empty scenes array with sequential order', (_slug, template) => {
    expect(template.scenes.length).toBeGreaterThan(0)
    expect(template.scenes.map(s => s.order)).toEqual(
      Array.from({ length: template.scenes.length }, (_, i) => i + 1),
    )
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has valid technical keys', (_slug, template) => {
    expect(template.technical.aspectRatio).toMatch(/^\d+:\d+$/)
    expect(template.technical.durationSeconds).toBeGreaterThan(0)
    expect(template.technical.resolution).toMatch(/^\d+x\d+$/)
    expect(template.technical.fps).toBeGreaterThan(0)
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has non-empty clone/exclude fields', (_slug, template) => {
    expect(template.clonePrompt.length).toBeGreaterThan(0)
    expect(template.negativePrompt.length).toBeGreaterThan(0)
    expect(template.cloneNotes.length).toBeGreaterThan(0)
    expect(template.excludeInClone.length).toBeGreaterThan(0)
  })
})
```

Run it:

```bash
cd products/agent-platform/packages/api && pnpm exec vitest run seeds/creative-templates.test.ts
```

Expected: PASS. This runs against the hand-authored data written in Step 1 above — if it fails, fix the `TEMPLATES` array, not the test.

- [ ] **Step 3: Register the npm script**

In `products/agent-platform/packages/api/package.json`, add alongside the existing `db:seed:*` scripts:

```json
"db:seed:creative-templates": "tsx seeds/creative-templates.ts",
```

- [ ] **Step 4: Run it against local dev DB and verify idempotency**

```bash
cd products/agent-platform/packages/api
pnpm db:seed:creative-templates
pnpm db:seed:creative-templates
```

Expected: first run logs 6 `upserted` lines and inserts 6 rows; second run logs 6 `upserted` lines and **updates** the same 6 rows (not a unique-constraint error, not 12 rows total). Confirm row count with:

```bash
psql "$DATABASE_URL" -c "SELECT slug, tenant_id FROM creative_templates ORDER BY slug"
```

Expected: exactly 6 rows, all `tenant_id` NULL, slugs matching `problem-solution`, `product-demo`, `testimonial`, `before-after`, `offer`, `ugc-review`.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/seeds/creative-templates.ts \
        products/agent-platform/packages/api/seeds/creative-templates.test.ts \
        products/agent-platform/packages/api/package.json
git commit -m "feat(seed): add creative_templates recreation-contract data"
```

---

## Task 3: `retrieve_template` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.test.ts`

**Interfaces:**
- Consumes: `creative_templates` table (Task 1/2, columns as in Task 1's schema).
- Produces: `retrieveTemplate` (a `createTool(...)` export) — consumed by Task 4, which registers it on `directorAgent`/`directorAgentDelegate`. Output shape:
  ```typescript
  { found: true, slug, title, category, clonePrompt, negativePrompt, cloneNotes, excludeInClone, technical, scenes, referenceFileId }
  | { found: false }
  ```

- [ ] **Step 1: Write the failing test**

**[review]** The first draft of this test was broken two ways: the mocked pool had no `.on` (the tool calls `_pool.on('error', ...)` right after creating it, which every other tool mock in this repo includes — see `usage.test.ts`/`serverTools.test.ts`), and each test tried to set a fresh `getPool.mockReturnValue(...)`, but the tool only ever calls `makeAppPool(5)` **once** (it memoizes `_pool` at module scope) — so only the first test's mock return value ever takes effect, and `vi.resetAllMocks()` then wipes that first client's `query` implementation out from under tests 2 and 3. Fixed below: one stable mocked pool object created once, its `connect` re-armed per test rather than replacing the pool itself.

```typescript
// apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('../../db.js', () => ({ makeAppPool: () => getPool() }))

import { retrieveTemplate } from './retrieveTemplate.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}

function mockClient(rows: unknown[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    release: vi.fn(),
  }
}

// The tool calls makeAppPool(5) exactly once and memoizes the result at
// module scope (same pattern as fetchPRD.ts) — so this mocked pool object
// must be the SAME instance across every test in this file. Each test
// re-arms `pool.connect` to resolve its own client; it must not replace the
// pool itself via a fresh getPool.mockReturnValue(...), or the tool's first
// (and only) makeAppPool() call from an earlier test wins forever.
const pool = { connect: vi.fn(), on: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  // resetAllMocks wipes pool.connect/pool.on's recorded implementation too
  // (they're vi.fn() instances), but not the `pool` object reference itself
  // — re-point getPool at it every test; only the first call the tool ever
  // makes actually matters, but this keeps the mock explicit and safe.
  getPool.mockReturnValue(pool)
})

describe('retrieveTemplate tool', () => {
  it('returns the full contract for a known slug', async () => {
    const row = {
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clone_prompt: 'Show the product in use.', negative_prompt: 'No competitor branding.',
      clone_notes: 'One benefit only.', exclude_in_clone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      reference_file_id: null,
    }
    const client = mockClient([row])
    pool.connect.mockResolvedValue(client)

    const result = await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({
      found: true,
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clonePrompt: 'Show the product in use.', negativePrompt: 'No competitor branding.',
      cloneNotes: 'One benefit only.', excludeInClone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      referenceFileId: null,
    })
    expect(client.release).toHaveBeenCalled()
  })

  it('returns found: false for an unknown slug, without throwing', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    const result = await retrieveTemplate.execute!({ slug: 'nonexistent' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({ found: false })
  })

  it('scopes the query to global rows or the caller\'s own tenant', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({ tenantId: 't1' }))

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id IS NULL OR ($2'),
      ['product-demo', 't1'],
    )
  })

  it('does not filter by tenant when tenantId is empty (unresolved context) — global templates must still resolve', async () => {
    const row = {
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clone_prompt: 'Show the product in use.', negative_prompt: 'No competitor branding.',
      clone_notes: 'One benefit only.', exclude_in_clone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      reference_file_id: null,
    }
    const client = mockClient([row])
    pool.connect.mockResolvedValue(client)

    // No tenantId set in context at all — ctx({}) leaves requestContext
    // empty, so the tool's `?? ''` default kicks in, same as a real request
    // where tenant resolution hasn't run yet.
    const result = await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({}))

    expect(result).toMatchObject({ found: true, slug: 'product-demo' })
  })
})
```

**[review, added]** The last test above guards against a real bug the query would otherwise have: `tenantContextSchema` defaults `tenantId` to `''`, and casting an empty string against a `uuid` column (`tenant_id = $2`) raises `invalid input syntax for type uuid: ""` in real Postgres — the same failure class `docs/media-generation/README.md`'s "Known issues" section already documents for `fileIngest.ts`. The implementation in Step 3 below guards this explicitly; this test's mocked `client.query` can't reproduce the real Postgres type error, but it does prove the tool still returns a result rather than assuming a tenant is always present — Step 3's SQL construction is what actually prevents the crash.

- [ ] **Step 2: Run it and verify it fails**

```bash
cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/retrieveTemplate.test.ts
```

Expected: FAIL — `retrieveTemplate.js` does not exist yet.

- [ ] **Step 3: Write the tool**

```typescript
// apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'
import { makeAppPool } from '../../db.js'
import { tenantContextSchema } from '../context.js'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = makeAppPool(5)
    _pool.on('error', (err) => {
      console.error('[retrieveTemplate] pool error:', err.message)
    })
  }
  return _pool
}

const technicalSchema = z.object({
  aspectRatio: z.string(),
  durationSeconds: z.number(),
  resolution: z.string(),
  fps: z.number(),
})

const sceneSchema = z.object({
  order: z.number(),
  shotType: z.string(),
  action: z.string(),
  onScreenText: z.string().optional(),
  audio: z.string().optional(),
})

export const retrieveTemplate = createTool({
  id: 'retrieve-template',
  description: 'Fetches a creative-library template\'s full recreation contract by slug — structure, scenes, technical constraints, and what to keep vs exclude. Call this before generating anything from a brief that references a template.',
  requestContextSchema: tenantContextSchema,
  inputSchema: z.object({
    slug: z.string().describe('The template slug from the creative brief, e.g. "product-demo"'),
  }),
  outputSchema: z.union([
    z.object({
      found: z.literal(true),
      slug: z.string(),
      title: z.string(),
      category: z.string(),
      clonePrompt: z.string(),
      negativePrompt: z.string(),
      cloneNotes: z.string(),
      excludeInClone: z.string(),
      technical: technicalSchema,
      scenes: z.array(sceneSchema),
      referenceFileId: z.string().nullable(),
    }),
    z.object({ found: z.literal(false) }),
  ]),
  execute: async (inputData, execContext) => {
    const slug = (inputData as { slug: string } | undefined)?.slug ?? ''
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      const { rows } = await client.query<{
        slug: string
        title: string
        category: string
        clone_prompt: string
        negative_prompt: string
        clone_notes: string
        exclude_in_clone: string
        technical: unknown
        scenes: unknown
        reference_file_id: string | null
      }>(
        // [review] tenantContextSchema defaults tenantId to '' when the
        // context hasn't resolved a tenant yet. Casting '' against the
        // tenant_id uuid column would raise "invalid input syntax for type
        // uuid" — the same failure class docs/media-generation/README.md's
        // "Known issues" section documents for fileIngest.ts. Guarding with
        // $2 <> '' means an unresolved tenantId still finds the global row
        // instead of crashing, which is correct here (unlike fetchPRD.ts,
        // where a PRD genuinely requires a real tenant).
        //
        // ORDER BY tenant_id NULLS LAST: ASC puts non-NULL rows first, so a
        // future tenant-owned override (once tenant-authored templates
        // exist) wins over the global row for the same slug. Do not "fix"
        // this to NULLS FIRST — that would invert the override, not just
        // the null placement.
        `SELECT slug, title, category, clone_prompt, negative_prompt, clone_notes,
                exclude_in_clone, technical, scenes, reference_file_id
         FROM creative_templates
         WHERE slug = $1 AND (tenant_id IS NULL OR ($2 <> '' AND tenant_id = $2::uuid)) AND status = 'active'
         ORDER BY tenant_id NULLS LAST
         LIMIT 1`,
        [slug, tenantId],
      )

      if (rows.length === 0) {
        return { found: false }
      }

      const row = rows[0]
      return {
        found: true,
        slug: row.slug,
        title: row.title,
        category: row.category,
        clonePrompt: row.clone_prompt,
        negativePrompt: row.negative_prompt,
        cloneNotes: row.clone_notes,
        excludeInClone: row.exclude_in_clone,
        technical: row.technical as z.infer<typeof technicalSchema>,
        scenes: row.scenes as z.infer<typeof sceneSchema>[],
        referenceFileId: row.reference_file_id,
      }
    } finally {
      client.release()
    }
  },
})
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/retrieveTemplate.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 5: Type-check**

**[review, added]** This was the one task in the original plan with no type-check step, and it's the one writing the most novel TypeScript (`z.union` output schema). If `tsc` complains that `{ found: false }` doesn't narrow against `z.literal(false)`, change the return to `{ found: false as const }`.

```bash
cd apps/agent-orchestrator && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.ts \
        apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.test.ts
git commit -m "feat(orchestrator): add retrieve_template tool"
```

---

## Task 4: Wire `retrieve_template` into Director

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/__tests__/delegateVariants.test.ts`

**Interfaces:**
- Consumes: `retrieveTemplate` from Task 3 (`apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.js`).
- Produces: both `directorAgent.tools` and `directorAgentDelegate.tools` now include a `retrieve_template` key — consumed at runtime by Olmo's delegation.

- [ ] **Step 1: Add the import**

In `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`, add to the existing tool imports:

```typescript
import { retrieveTemplate } from '../tools/retrieveTemplate.js'
```

- [ ] **Step 2: Register on both agent instances**

**[review]** The `tools:` line is byte-identical in both `directorAgent` and `directorAgentDelegate` (lines 61 and 80 in the current file) — an `Edit` call without `replace_all: true` will fail with "not unique" against this file. Use `replace_all: true` (or apply the same edit twice, once per surrounding context) so **both** occurrences change; this is the spec's headline fix and missing either one ships a tool that only half-works.

Change both occurrences of the `tools:` line from:

```typescript
tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo },
```

to:

```typescript
tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate },
```

- [ ] **Step 3: Add the instruction rule and not-found handling**

In `directorInstructions`'s `defaultInstructions` template literal, add a new section (placed before the existing `## Rules` section, since retrieval must happen first):

```typescript
  const defaultInstructions = `You are Director — an image generation specialist. You create and edit images from descriptions.

## Templates
- If the creative brief references a template by slug, call retrieve_template with that slug BEFORE calling generate_image or generate_video. Use the returned clonePrompt, negativePrompt, cloneNotes, excludeInClone, technical, and scenes as your source of truth for structure and constraints — not just the brief's free text.
- If retrieve_template returns { found: false }, tell the user the referenced template could not be found and ask them to pick again — do not invent a structure or proceed as if a contract existed.

## Rules
...` // (existing rules unchanged below this point)
```

- [ ] **Step 4: Type-check**

```bash
cd apps/agent-orchestrator && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Add a real tools-registration test**

**[review, replaces a false claim]** The original plan pointed at the existing `delegateVariants.test.ts` and said it would "fail to build if this task breaks either module" — true, but only for an import/syntax break, not for the actual risk here: registering `retrieve_template` on `directorAgent` and forgetting `directorAgentDelegate` (or vice versa) compiles and imports fine, and that existing test asserts only `hasOwnMemory()`/`getDescription()` parity, nothing about tools. That's the spec's headline blocker, and it needs its own assertion.

Add this test to `apps/agent-orchestrator/src/mastra/agents/__tests__/delegateVariants.test.ts`, alongside the existing `it(...)` blocks in the same `describe` block:

```typescript
  it('directorAgent and directorAgentDelegate both expose retrieve_template', async () => {
    const standaloneTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(standaloneTools)).toContain('retrieve_template')
    expect(Object.keys(delegateTools)).toContain('retrieve_template')
  })
```

- [ ] **Step 6: Run the delegate-variants test**

```bash
cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/agents/__tests__/delegateVariants.test.ts
```

Expected: PASS, including the new test — this is the check that actually catches a half-applied Step 2.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts \
        apps/agent-orchestrator/src/mastra/agents/__tests__/delegateVariants.test.ts
git commit -m "feat(orchestrator): wire retrieve_template into Director"
```

---

## Task 5: Web — trim the template shape (types + composer)

**Files:**
- Modify: `apps/web/components/platform/chat/creativeLibraryTemplates.ts`
- Modify: `apps/web/components/platform/chat/creative-library/creativeBriefModel.ts`
- Modify: `apps/web/components/platform/chat/CreativeLibrary.tsx`
- Modify: `apps/web/components/platform/chat/creative-library/creativeBrief.ts`

**Interfaces:**
- Produces: `TemplateSelection` no longer has a `prompt` field; `CREATIVE_TEMPLATES` entries no longer have `prompt`. Consumed by Task 6 (test updates).
- Consumes nothing new — this task only removes a field and updates two functions that read it.

- [ ] **Step 1: Drop `prompt` from the static catalog**

In `apps/web/components/platform/chat/creativeLibraryTemplates.ts`, remove the `prompt: '...'` key from all 6 entries. Example for the first one — before:

```typescript
{ id: 'problem-solution', title: 'Problem → Solution', category: 'Explainer', image: '/creative/templates/problem-solution.png', description: 'Open with a familiar frustration, then show the product fixing it.', prompt: 'Use a Problem → Solution ad structure: show the audience\'s problem, introduce the product, demonstrate the benefit, and finish with a clear call to action.' },
```

after:

```typescript
{ id: 'problem-solution', title: 'Problem → Solution', category: 'Explainer', image: '/creative/templates/problem-solution.png', description: 'Open with a familiar frustration, then show the product fixing it.' },
```

Repeat for all 6 entries (`product-demo`, `testimonial`, `before-after`, `offer`, `ugc-review`), removing only the trailing `prompt: '...'` field from each — leave `id`/`title`/`category`/`image`/`description` untouched. Note: these `id` values already match the seed script's `slug` values from Task 2 exactly, so no rename is needed.

- [ ] **Step 2: Drop `prompt` from the `TemplateSelection` type**

In `apps/web/components/platform/chat/creative-library/creativeBriefModel.ts`, change:

```typescript
export interface TemplateSelection {
    kind: 'template';
    id: string;
    title: string;
    category: string;
    prompt: string;
    image: string;
}
```

to:

```typescript
export interface TemplateSelection {
    kind: 'template';
    id: string;
    title: string;
    category: string;
    image: string;
}
```

- [ ] **Step 3: Fix the field leak in `CreativeLibrary.tsx`**

In `apps/web/components/platform/chat/CreativeLibrary.tsx`, the template selection handler currently spreads the whole catalog entry (which, after Step 1, still includes `description` — a field `TemplateSelection` never declared). Change:

```typescript
onClick={() => onSelect({ kind: 'template', ...template })}
```

to an explicit field list:

```typescript
onClick={() => onSelect({ kind: 'template', id: template.id, title: template.title, category: template.category, image: template.image })}
```

- [ ] **Step 4: Stop interpolating the template prompt into the message, send the slug instead**

In `apps/web/components/platform/chat/creative-library/creativeBrief.ts`, in `buildCreativeBriefMessage`, change:

```typescript
brief.template ? `- Template: ${brief.template.title} (${brief.template.category})\n  ${brief.template.prompt}` : null,
```

to:

```typescript
brief.template ? `- Template: ${brief.template.title} (${brief.template.category})\n  Template slug: ${brief.template.id}` : null,
```

**[review]** Dropped the "Call retrieve_template..." sentence from the first draft — it duplicated Task 4 Step 3's instruction rule and put a tool-invocation directive into client-composed transcript text, exactly the category of duplication the spec moved away from (full contract text no longer lives client-side; an instruction to call a specific tool shouldn't either). The slug alone is enough — Director's own instructions already say what to do with it.

- [ ] **Step 5: Make `isTemplateSelection` backward-compatible with historical `prompt` data**

Still in `creativeBrief.ts`, find:

```typescript
function isTemplateSelection(value: unknown): value is NonNullable<CreativeBrief['template']> {
    return isRecord(value) && value.kind === 'template' && hasString(value, 'id') && hasString(value, 'title')
        && hasString(value, 'category') && hasString(value, 'prompt') && isTrustedCreativeImage(value.image);
}
```

Change to (drop the `hasString(value, 'prompt')` requirement entirely — do not replace it with an optional check, since the type no longer declares the field and new drafts never produce it; the predicate simply stops caring whether `prompt` is present, which is what makes it accept both old rows that have it and new rows that don't):

```typescript
function isTemplateSelection(value: unknown): value is NonNullable<CreativeBrief['template']> {
    return isRecord(value) && value.kind === 'template' && hasString(value, 'id') && hasString(value, 'title')
        && hasString(value, 'category') && isTrustedCreativeImage(value.image);
}
```

- [ ] **Step 6: Type-check**

```bash
cd apps/web && pnpm exec tsc --noEmit
```

Expected: errors only in the test files touched by Task 6 (not yet updated) — confirms the type change is doing its job. If there are unexpected errors elsewhere, investigate before proceeding.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/creativeLibraryTemplates.ts \
        apps/web/components/platform/chat/creative-library/creativeBriefModel.ts \
        apps/web/components/platform/chat/CreativeLibrary.tsx \
        apps/web/components/platform/chat/creative-library/creativeBrief.ts
git commit -m "feat(web): send template slug instead of full prompt text"
```

---

## Task 6: Web — update tests, add backward-compatibility test

**Files:**
- Modify: `apps/web/components/platform/chat/creative-library/creativeBrief.test.ts`
- Modify: `apps/web/components/platform/chat/creative-library/CreativeBriefChips.test.tsx`
- Modify: `apps/web/components/platform/chat/MessageItemCreativeBrief.test.tsx`
- Modify: `apps/web/components/platform/chat/creative-library/useCreativeBriefDraft.test.tsx`
- Modify: `apps/web/components/platform/chat/CreativeLibrary.test.tsx`

**Interfaces:**
- Consumes: `TemplateSelection` (Task 5, no `prompt`), `isTemplateSelection`/`buildCreativeBriefMessage` (Task 5).

- [ ] **Step 1: Remove `prompt` from test fixtures in the four files that construct a `TemplateSelection` literal**

In `apps/web/components/platform/chat/creative-library/CreativeBriefChips.test.tsx`, change:

```typescript
template: { kind: 'template' as const, id: 'demo', title: 'Product Demo', category: 'Demonstration', prompt: 'Show it.', image: '/creative/templates/product-demo.png' },
```

to:

```typescript
template: { kind: 'template' as const, id: 'demo', title: 'Product Demo', category: 'Demonstration', image: '/creative/templates/product-demo.png' },
```

In `apps/web/components/platform/chat/creative-library/creativeBrief.test.ts`, remove `prompt: '...'` from the three literals on the lines containing `template: { kind: 'template', id: 'demo', ...}`, `{ kind: 'template', id: 'one', ...}`, and `{ kind: 'template', id: 'two', ...}` — same field removal pattern as above, only the `prompt` key comes out.

In `apps/web/components/platform/chat/creative-library/useCreativeBriefDraft.test.tsx`, remove `prompt: 'Show it.',` from the `kind: 'template', id: 'demo', ...` literal.

In `apps/web/components/platform/chat/MessageItemCreativeBrief.test.tsx`, remove `prompt: 'Show the product.',` from the `template: { kind: 'template', id: 'demo', ...}` literal.

- [ ] **Step 2: Fix the assertion that checks prompt content**

In `apps/web/components/platform/chat/CreativeLibrary.test.tsx`, change:

```typescript
expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'template', id: 'testimonial', prompt: expect.stringContaining('Do not invent customer quotes') }));
```

to an assertion on what Task 5 Step 3 actually now sends (no `prompt`, and no leaked `description` either — this is the regression the review flagged in `CreativeLibrary.tsx`'s spread):

```typescript
expect(onSelect).toHaveBeenCalledWith({ kind: 'template', id: 'testimonial', title: 'Testimonial', category: 'Social proof', image: '/creative/templates/testimonial.png' });
```

(Adjust `title`/`category`/`image` to match whatever `CREATIVE_TEMPLATES`'s `testimonial` entry actually holds after Task 5 Step 1 — read the file to confirm the exact values before writing this assertion.)

- [ ] **Step 3: Add the historical-transcript backward-compatibility test**

In `apps/web/components/platform/chat/creative-library/creativeBrief.test.ts`, add a new test alongside the existing ones:

```typescript
it('still parses a historical message annotation that carries the old prompt field', () => {
    // Simulates a chat message persisted before this change shipped — its
    // JSON still has `prompt` on the template selection. isTemplateSelection
    // must accept this without requiring `prompt`, or every past templated
    // message stops rendering the moment this ships.
    const legacyBrief = {
        template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', prompt: 'Show it.', image: '/creative/templates/product-demo.png' },
        avatar: null, product: null, voice: null,
    };
    const encoded = encodeURIComponent(JSON.stringify({ direction: 'Make an ad', brief: legacyBrief })).replaceAll('-', '%2D');
    const content = `some direction text\n\n<!-- olmo-creative-brief:v1:${encoded} -->`;

    const parsed = parseCreativeBriefPresentation(content);

    expect(parsed).not.toBeNull();
    expect(parsed!.brief.template).toEqual(
        expect.objectContaining({ id: 'demo', title: 'Product Demo', category: 'Demonstration' }),
    );
});
```

Add `parseCreativeBriefPresentation` to this test file's existing import from `./creativeBrief` if it isn't already imported.

- [ ] **Step 4: Run the full web test suite for this area**

```bash
cd apps/web && pnpm exec vitest run components/platform/chat
```

Expected: PASS, including the new backward-compatibility test.

- [ ] **Step 5: Full type-check and build**

```bash
cd apps/web && pnpm exec tsc --noEmit && pnpm build
```

Expected: no errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/chat/creative-library/creativeBrief.test.ts \
        apps/web/components/platform/chat/creative-library/CreativeBriefChips.test.tsx \
        apps/web/components/platform/chat/MessageItemCreativeBrief.test.tsx \
        apps/web/components/platform/chat/creative-library/useCreativeBriefDraft.test.tsx \
        apps/web/components/platform/chat/CreativeLibrary.test.tsx
git commit -m "test(web): update template fixtures, add legacy-transcript compatibility test"
```

---

## Final verification

- [ ] Run the full orchestrator suite: `cd apps/agent-orchestrator && pnpm exec vitest run`
- [ ] Run the full web suite: `cd apps/web && pnpm exec vitest run`
- [ ] Run `pnpm type-check` and `pnpm lint` from the repo root (per CLAUDE.md's useful local commands)
- [ ] Manually confirm via `psql` that all 6 `creative_templates` rows exist with non-empty `scenes` arrays and valid `technical` JSON (repeat Task 2 Step 3's query)
- [ ] **[review, corrected]** The spec's Testing section also asked for a `scripts/testDirector.ts`-style harness run asserting `retrieve_template` is called before any generation tool call. This plan descopes writing that harness script itself (not because it needs the GCP VM specifically — it needs real model credentials and a real DB connection with the seeded rows, which is a different and possibly-available requirement, not exclusively a VM-only one). Whoever has those credentials should run:
  ```bash
  NODE_EXTRA_CA_CERTS=$(pwd)/supabase-ca.crt npx tsx scripts/testDirector.ts "generate an image using the Product Demo template"
  ```
  against `apps/agent-orchestrator` after this plan's changes are deployed (or locally with a `.env` pointed at a DB carrying Task 2's seeded rows), and confirm the tool-call trace shows `retrieve_template` invoked before `generate_image`.
