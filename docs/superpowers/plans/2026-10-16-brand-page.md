# Brand Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AI-filled brand per workspace, editable on a Brand page and used by Olmo and the end card in every ad.

**Architecture:** A `creative_brand` table (one row per tenant). The API Lambda reads a website with the guarded fetch already used for product import, then asks the orchestrator to run a Mastra workflow (`brandImportWorkflow`) whose `brandFillAgent` returns the fields through `structuredOutput`. Instagram is read on the orchestrator (TikHub). The workflow reports back to an internal API route that saves the logo to Drive and merges fields, never overwriting user edits. Chat loads the brand into `RequestContext`; the existing `instructions` resolver appends a `## Your brand` block; two `createTool` tools (`update_brand`, `import_brand`) let Olmo save and import; `composite_end_card` defaults to the brand logo.

**Tech Stack:** Drizzle + Postgres (Supabase), Hono on Lambda, Mastra 1.64 (`@mastra/core` Agent, workflows, RequestContext, createTool), Next.js App Router + Tailwind + shadcn, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-brand-design.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/brand-page` (branch `worktree-brand-page`). Never `sam deploy` from a worktree; deploys happen from the main checkout after merge.
- One brand per workspace, keyed on `tenant_id`. Every query filters by `tenantId`.
- Product code only: schema in `products/agent-platform/packages/schema`, API in `products/agent-platform/packages/api`, nothing in `packages/foundation/*`.
- Regions: `IN`, `US`, `UK`, `AE`, `SG`, `GLOBAL`; default `IN`. Emoji policy: `none`, `minimal`, `moderate`, `expressive`; default `minimal`. Validated in Zod, not DB enums.
- Tone words 3 to 5 when filled by AI; the user may keep fewer. Max 5.
- The AI never writes `bannedPhrases`. Signature phrases from an import must appear verbatim (case-insensitive) in the source text.
- An import never overwrites a field listed in `edited_by_user`.
- Colours are `#RRGGBB`; anything else is dropped.
- Tool and structured-output schemas use string enums only (Gemini rejects numeric enums).
- The user never sees provider names, status codes, "blocked", "server" or "download". Failure copy: "Couldn't read that. Tell Olmo about your brand instead."
- The import is not charged to the user; model cost is logged with `persistCost`.
- Prompt changes are additive: no existing instruction text is removed.
- Web UI: no boxed containers (no bg + border + rounded wrappers around sections), rose accent, checked in light and dark, no credit counts. Run `tsc --noEmit` in `apps/web` before every web commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Spec/plan files under `docs/` need `git add -f` (`*.md` is gitignored).

## Review Focus

1. **A workflow that dies mid-run** (VM restart, gateway outage) must not leave the page on "Reading…" forever: `GET /brand` reports `importing` older than 3 minutes as `failed`. Test in Task 2.
2. **An edit made while an import is running** must survive the import's result: the merge skips `edited_by_user` columns, and a result arriving for a row no longer `importing` is ignored. Tests in Task 2 and Task 6.
3. **A site whose logo is SVG or missing** must still produce a brand (text fields, colours) with the logo left empty, not a failed import. Tests in Task 4 and Task 6.
4. **Instagram input in its three shapes** (`@name`, `name`, `https://www.instagram.com/name/?hl=en`) and website input without `https://` (`yourbrand.com`) must be recognised; anything else gets a clear 400. Test in Task 5.
5. **A brand with no logo, or the user saying "no logo"** must not put a logo on the end card, and an explicit `logoFileId` must win over the brand logo. Test in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `products/agent-platform/packages/schema/creativeBrand.ts` (new) | Table definition |
| `products/agent-platform/packages/schema/index.ts` (modify) | Export it |
| `packages/foundation/database/migrations/0102_*.sql` (generated) | Migration |
| `products/agent-platform/packages/api/lib/brandSchema.ts` (new) | Zod field schemas, constants, `BrandRecord` type |
| `products/agent-platform/packages/api/lib/brandRecords.ts` (new) | Row → record, readiness, staleness, merge, DB reads/writes |
| `products/agent-platform/packages/api/lib/safeFetch.ts` (new) | `guardedFetch`, `readCapped`, `createDeadline`, `importOneImage` moved from `routes/products.import.ts` |
| `products/agent-platform/packages/api/routes/products.import.ts` (modify) | Import those from `lib/safeFetch.ts` |
| `products/agent-platform/packages/api/lib/productPageExtract.ts` (modify) | Export `jsonLdCandidates` |
| `products/agent-platform/packages/api/lib/brandPageExtract.ts` (new) | Website facts from HTML + CSS |
| `products/agent-platform/packages/api/lib/brandSource.ts` (new) | Detect website vs Instagram from one string |
| `products/agent-platform/packages/api/lib/brandImport.ts` (new) | Read website, call orchestrator |
| `products/agent-platform/packages/api/routes/brand.ts` (new) | `GET /brand`, `PATCH /brand`, `POST /brand/import` |
| `products/agent-platform/packages/api/routes/internal/brand.ts` (new) | `POST /internal/brand/import-result` |
| `products/agent-platform/packages/api/index.ts` (modify) | Mount both |
| `apps/agent-orchestrator/src/mastra/brand/types.ts` (new) | `TenantBrand`, `WebsiteFacts`, `BrandFill` |
| `apps/agent-orchestrator/src/mastra/brand/tikhub.ts` (new) | Instagram profile read |
| `apps/agent-orchestrator/src/mastra/agents/brandFillAgent.ts` (new) | Mastra Agent + fill schema + prompt builder |
| `apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.ts` (new) | gather → fill → report |
| `apps/agent-orchestrator/src/routes/brandImport.ts` (new) | `/internal/brand/import` |
| `apps/agent-orchestrator/src/mastra/index.ts`, `src/app.ts` (modify) | Register workflow and route |
| `apps/agent-orchestrator/src/usage.ts` (modify) | `fetchTenantBrand` |
| `apps/agent-orchestrator/src/mastra/context.ts` (modify) | `brand` key |
| `apps/agent-orchestrator/src/routes/chatStream.ts` (modify) | Load brand per turn |
| `apps/agent-orchestrator/src/mastra/agents/brandBlock.ts` (new) | `## Your brand` instructions text |
| `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (modify) | Append block; memory contract line; register tools |
| `apps/agent-orchestrator/src/mastra/tools/brandTools.ts` (new) | `update_brand`, `import_brand` |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts` (modify) | Brand logo default, `noLogo` |
| `apps/web/components/platform/brand/brandApi.ts` (new) | Client calls + types |
| `apps/web/components/platform/brand/BrandEmptyState.tsx` (new) | Link box + chat link |
| `apps/web/components/platform/brand/BrandForm.tsx` (new) | Readiness, Basics, Voice, Visual identity, source line |
| `apps/web/app/[tenant]/dashboard/brand/page.tsx` (new) | Page, polling |
| `apps/web/lib/sidebar-items.ts` (modify) | Brand item; "Branding" → "Workspace look" |
| `apps/web/app/[tenant]/dashboard/chat/page.tsx` (modify) | `?prefill=` support |

---

### Task 1: `creative_brand` table and migration

**Files:**
- Create: `products/agent-platform/packages/schema/creativeBrand.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Generated: `packages/foundation/database/migrations/0102_<name>.sql` and `meta/*`

**Interfaces:**
- Produces: `creativeBrand` table, types `CreativeBrand`, `NewCreativeBrand`, `BrandColors` from `@serverless-saas/agent-schema/creativeBrand`.

- [ ] **Step 1: Write the table**

```ts
// products/agent-platform/packages/schema/creativeBrand.ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { files } from '@serverless-saas/database/schema/files';

// A workspace's ad brand: how it sounds and looks in everything Olmo makes.
// Deliberately NOT tenants.brandName/logoFileId/brandColor — those theme the
// app itself (white-label) and must not change when the ad brand changes.
// One row per tenant; a row exists only once something has been saved.
export type BrandColors = Partial<Record<'primary' | 'secondary' | 'accent' | 'text' | 'background' | 'muted', string>>;

export const creativeBrand = pgTable('creative_brand', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  // Nullable: an import creates the row before the name is known.
  name: text('name'),
  oneLiner: text('one_liner'),
  audience: text('audience'),
  region: text('region').notNull().default('IN'), // validated in Zod (lib/brandSchema.ts)
  toneWords: text('tone_words').array().notNull().default(sql`'{}'::text[]`),
  emojiPolicy: text('emoji_policy').notNull().default('minimal'), // validated in Zod
  signaturePhrases: text('signature_phrases').array().notNull().default(sql`'{}'::text[]`),
  bannedPhrases: text('banned_phrases').array().notNull().default(sql`'{}'::text[]`),
  ctaExamples: text('cta_examples').array().notNull().default(sql`'{}'::text[]`),
  voiceNotes: text('voice_notes'),
  colors: jsonb('colors').$type<BrandColors>().notNull().default(sql`'{}'::jsonb`),
  headlineFont: text('headline_font'),
  logoFileId: uuid('logo_file_id').references(() => files.id, { onDelete: 'set null' }),
  faviconFileId: uuid('favicon_file_id').references(() => files.id, { onDelete: 'set null' }),
  mascotFileId: uuid('mascot_file_id').references(() => files.id, { onDelete: 'set null' }),
  sourceType: text('source_type'), // 'website' | 'instagram' | 'chat'
  sourceValue: text('source_value'),
  importStatus: text('import_status').notNull().default('idle'), // 'idle' | 'importing' | 'done' | 'failed'
  importError: text('import_error'), // for logs only, never shown raw
  importStartedAt: timestamp('import_started_at', { withTimezone: true }),
  importedAt: timestamp('imported_at', { withTimezone: true }),
  // API field names (camelCase) the user changed by hand or through update_brand.
  // An import never overwrites these.
  editedByUser: text('edited_by_user').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  tenantUnique: uniqueIndex('creative_brand_tenant_unique').on(t.tenantId),
}));

export type CreativeBrand = typeof creativeBrand.$inferSelect;
export type NewCreativeBrand = typeof creativeBrand.$inferInsert;
```

Before writing, confirm the `files` table export path: `git grep -n "export const files = pgTable" -- packages/foundation/database/schema`. Use the file that grep names in the import.

- [ ] **Step 2: Export from the barrel**

In `products/agent-platform/packages/schema/index.ts`, next to `export * from './creativeProducts';` add:

```ts
export * from './creativeBrand';
```

- [ ] **Step 3: Build the schema package and generate the migration**

Run:
```bash
pnpm -C products/agent-platform/packages/schema build
cd packages/foundation/database && pnpm exec drizzle-kit generate
```
Expected: one new `migrations/0102_*.sql` containing `CREATE TABLE "creative_brand"` and `creative_brand_tenant_unique`, and nothing else. If the SQL touches any other table, stop: the local schema is out of sync with `meta/`; report it instead of committing.

- [ ] **Step 4: Commit**

```bash
git add products/agent-platform/packages/schema/creativeBrand.ts products/agent-platform/packages/schema/index.ts packages/foundation/database/migrations
git commit -m "feat(schema): creative_brand table, one ad brand per workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Brand schema, record shape, merge rules and DB access (API)

**Files:**
- Create: `products/agent-platform/packages/api/lib/brandSchema.ts`
- Create: `products/agent-platform/packages/api/lib/brandRecords.ts`
- Test: `products/agent-platform/packages/api/__tests__/brandRecords.test.ts`

**Interfaces:**
- Consumes: `creativeBrand`, `CreativeBrand`, `BrandColors` (Task 1).
- Produces:
  - `brandSchema.ts`: `BRAND_REGIONS`, `EMOJI_POLICIES`, `COLOR_ROLES`, `brandPatchSchema` (Zod), `brandFillSchema` (Zod, import result fields), `type BrandPatch`, `type BrandFill`, `type BrandRecord`, `type BrandImageRef = { fileId: string; url: string | null }`.
  - `brandRecords.ts`:
    - `toBrandRecord(row: CreativeBrand, urls: Partial<Record<'logo'|'favicon'|'mascot', string|null>>, now?: Date): BrandRecord`
    - `effectiveImportStatus(row, now): { status, error }` (stale rule)
    - `mergeImport(row: CreativeBrand, fill: BrandFill, sourceText: string): Partial<NewCreativeBrand>`
    - `getBrandRow(tenantId): Promise<CreativeBrand | null>`
    - `getBrand(tenantId): Promise<BrandRecord | null>` (adds presigned URLs)
    - `startImport(tenantId, userId, source: { type: 'website' | 'instagram'; value: string }): Promise<void>`
    - `markImportFailed(tenantId, reason: string): Promise<void>`
    - `patchBrand(tenantId, userId, patch: BrandPatch): Promise<void>`
    - `applyImportResult(tenantId, fill: BrandFill, sourceText: string, images: { logoFileId?: string; faviconFileId?: string }): Promise<'applied' | 'ignored'>`
    - `IMPORT_STALE_MS = 180_000`

- [ ] **Step 1: Write `brandSchema.ts`**

```ts
// products/agent-platform/packages/api/lib/brandSchema.ts
import { z } from 'zod';

export const BRAND_REGIONS = ['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL'] as const;
export const EMOJI_POLICIES = ['none', 'minimal', 'moderate', 'expressive'] as const;
export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'text', 'background', 'muted'] as const;
export type BrandRegion = typeof BRAND_REGIONS[number];
export type EmojiPolicy = typeof EMOJI_POLICIES[number];
export type ColorRole = typeof COLOR_ROLES[number];

const HEX = /^#[0-9A-Fa-f]{6}$/;
const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, items: number) => z.array(line(max)).max(items);
const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === '' ? null : v));

/** Lenient colours: invalid hex values are dropped, not rejected (AI output and old clients). */
export const colorsSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const out: Partial<Record<ColorRole, string>> = {};
    for (const role of COLOR_ROLES) {
      const v = raw[role];
      if (typeof v === 'string' && HEX.test(v.trim())) out[role] = v.trim().toUpperCase();
    }
    return out;
  });

/** What PATCH /brand and update_brand accept. Every key optional; null clears. */
export const brandPatchSchema = z.object({
  name: nullableText(80).optional(),
  oneLiner: nullableText(200).optional(),
  audience: nullableText(300).optional(),
  region: z.enum(BRAND_REGIONS).optional(),
  toneWords: list(30, 5).optional(),
  emojiPolicy: z.enum(EMOJI_POLICIES).optional(),
  signaturePhrases: list(80, 10).optional(),
  bannedPhrases: list(80, 30).optional(),
  ctaExamples: list(80, 10).optional(),
  voiceNotes: nullableText(3000).optional(),
  colors: colorsSchema.optional(),
  headlineFont: nullableText(60).optional(),
  logoFileId: z.string().uuid().nullable().optional(),
  faviconFileId: z.string().uuid().nullable().optional(),
  mascotFileId: z.string().uuid().nullable().optional(),
}).strict();
export type BrandPatch = z.infer<typeof brandPatchSchema>;

/** The fields an import may fill (never bannedPhrases, never images — those come separately). */
export const brandFillSchema = z.object({
  name: z.string().trim().max(80).default(''),
  oneLiner: z.string().trim().max(200).default(''),
  audience: z.string().trim().max(300).default(''),
  region: z.enum(BRAND_REGIONS).catch('IN'),
  toneWords: z.array(z.string().trim().max(30)).default([]).transform((a) => a.filter(Boolean).slice(0, 5)),
  emojiPolicy: z.enum(EMOJI_POLICIES).catch('minimal'),
  signaturePhrases: z.array(z.string().trim().max(80)).default([]).transform((a) => a.filter(Boolean).slice(0, 10)),
  ctaExamples: z.array(z.string().trim().max(80)).default([]).transform((a) => a.filter(Boolean).slice(0, 10)),
  voiceNotes: z.string().trim().max(3000).default(''),
  colors: colorsSchema.default({}),
  headlineFont: z.string().trim().max(60).default(''),
});
export type BrandFill = z.infer<typeof brandFillSchema>;

export interface BrandImageRef { fileId: string; url: string | null }

export interface BrandRecord {
  name: string | null;
  oneLiner: string | null;
  audience: string | null;
  region: BrandRegion;
  toneWords: string[];
  emojiPolicy: EmojiPolicy;
  signaturePhrases: string[];
  bannedPhrases: string[];
  ctaExamples: string[];
  voiceNotes: string | null;
  colors: Partial<Record<ColorRole, string>>;
  headlineFont: string | null;
  logo: BrandImageRef | null;
  favicon: BrandImageRef | null;
  mascot: BrandImageRef | null;
  sourceType: 'website' | 'instagram' | 'chat' | null;
  sourceValue: string | null;
  importStatus: 'idle' | 'importing' | 'done' | 'failed';
  importedAt: string | null;
  ready: boolean;
  missing: Array<'name' | 'audience' | 'voice'>;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the failing tests for the pure functions**

```ts
// products/agent-platform/packages/api/__tests__/brandRecords.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: { getDownloadUrl: vi.fn() } }));

import { toBrandRecord, effectiveImportStatus, mergeImport, IMPORT_STALE_MS } from '../lib/brandRecords';
import { brandFillSchema, brandPatchSchema } from '../lib/brandSchema';
import type { CreativeBrand } from '@serverless-saas/agent-schema/creativeBrand';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const row = (over: Partial<CreativeBrand> = {}): CreativeBrand => ({
  id: 'b1', tenantId: 't1', name: null, oneLiner: null, audience: null, region: 'IN', toneWords: [],
  emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null,
  colors: {}, headlineFont: null, logoFileId: null, faviconFileId: null, mascotFileId: null,
  sourceType: null, sourceValue: null, importStatus: 'idle', importError: null, importStartedAt: null,
  importedAt: null, editedByUser: [], createdBy: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const fill = (over: Record<string, unknown> = {}) => brandFillSchema.parse({
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women 22-35 in Indian cities',
  region: 'IN', toneWords: ['warm', 'caring', 'honest'], emojiPolicy: 'minimal',
  signaturePhrases: ['Goodness Inside', 'made up phrase'], ctaExamples: ['Shop now'],
  voiceNotes: 'Natural, not chemical-free claims.', colors: { primary: '#00a651', accent: 'green' },
  headlineFont: 'Poppins', ...over,
});

describe('toBrandRecord', () => {
  it('reports readiness from name, audience and tone words', () => {
    expect(toBrandRecord(row(), {}, NOW)).toMatchObject({ ready: false, missing: ['name', 'audience', 'voice'] });
    const full = toBrandRecord(row({ name: 'X', audience: 'Y', toneWords: ['warm'] }), {}, NOW);
    expect(full).toMatchObject({ ready: true, missing: [] });
  });

  it('carries image urls and leaves images null when there is no file', () => {
    const r = toBrandRecord(row({ logoFileId: 'f1' }), { logo: 'https://s3/logo' }, NOW);
    expect(r.logo).toEqual({ fileId: 'f1', url: 'https://s3/logo' });
    expect(r.favicon).toBeNull();
  });
});

describe('effectiveImportStatus', () => {
  it('reports an import running longer than 3 minutes as failed', () => {
    const started = new Date(NOW.getTime() - IMPORT_STALE_MS - 1);
    expect(effectiveImportStatus(row({ importStatus: 'importing', importStartedAt: started }), NOW).status).toBe('failed');
  });

  it('keeps a recent import as importing', () => {
    const started = new Date(NOW.getTime() - 10_000);
    expect(effectiveImportStatus(row({ importStatus: 'importing', importStartedAt: started }), NOW).status).toBe('importing');
  });
});

describe('mergeImport', () => {
  it('fills empty fields and drops signature phrases not in the source text', () => {
    const patch = mergeImport(row(), fill(), 'Welcome to Mamaearth. goodness inside every bottle.');
    expect(patch.name).toBe('Mamaearth');
    expect(patch.signaturePhrases).toEqual(['Goodness Inside']);
    expect(patch.colors).toEqual({ primary: '#00A651' });
  });

  it('never overwrites a field the user edited', () => {
    const patch = mergeImport(row({ name: 'My Name', editedByUser: ['name', 'colors'] }), fill(), 'goodness inside');
    expect(patch).not.toHaveProperty('name');
    expect(patch).not.toHaveProperty('colors');
    expect(patch.audience).toBe('Women 22-35 in Indian cities');
  });

  it('never writes banned phrases and skips empty AI values', () => {
    const patch = mergeImport(row({ oneLiner: 'Kept' }), fill({ oneLiner: '', bannedPhrases: ['x'] }), '');
    expect(patch).not.toHaveProperty('bannedPhrases');
    expect(patch).not.toHaveProperty('oneLiner');
  });
});

describe('brandPatchSchema', () => {
  it('rejects unknown keys and clears with null', () => {
    expect(brandPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(brandPatchSchema.parse({ oneLiner: '' })).toEqual({ oneLiner: null });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd products/agent-platform/packages/api && npx vitest run __tests__/brandRecords.test.ts`
Expected: FAIL, `Cannot find module '../lib/brandRecords'`.

- [ ] **Step 4: Write `brandRecords.ts`**

```ts
// products/agent-platform/packages/api/lib/brandRecords.ts
import { and, eq } from 'drizzle-orm';
import { storageService } from '@serverless-saas/storage';
import { creativeBrand, type CreativeBrand, type NewCreativeBrand } from '@serverless-saas/agent-schema/creativeBrand';
import { db } from '../db';
import type { BrandFill, BrandPatch, BrandRecord, BrandRegion, EmojiPolicy } from './brandSchema';

/** A run older than this is reported failed: the workflow died without reporting. */
export const IMPORT_STALE_MS = 180_000;
const STALE_REASON = 'import did not report back in time';

// Fill keys an import may write, in API (camelCase) names — the same names
// edited_by_user stores.
const FILL_KEYS = [
  'name', 'oneLiner', 'audience', 'region', 'toneWords', 'emojiPolicy',
  'signaturePhrases', 'ctaExamples', 'voiceNotes', 'colors', 'headlineFont',
] as const;

const isEmpty = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function effectiveImportStatus(row: CreativeBrand, now: Date = new Date()): { status: BrandRecord['importStatus']; error: string | null } {
  const status = row.importStatus as BrandRecord['importStatus'];
  if (status === 'importing' && row.importStartedAt && now.getTime() - row.importStartedAt.getTime() > IMPORT_STALE_MS) {
    return { status: 'failed', error: STALE_REASON };
  }
  return { status, error: row.importError };
}

export function toBrandRecord(
  row: CreativeBrand,
  urls: Partial<Record<'logo' | 'favicon' | 'mascot', string | null>>,
  now: Date = new Date(),
): BrandRecord {
  const image = (fileId: string | null, url: string | null | undefined) => (fileId ? { fileId, url: url ?? null } : null);
  const missing: BrandRecord['missing'] = [];
  if (!row.name?.trim()) missing.push('name');
  if (!row.audience?.trim()) missing.push('audience');
  if (row.toneWords.length === 0) missing.push('voice');
  return {
    name: row.name, oneLiner: row.oneLiner, audience: row.audience,
    region: row.region as BrandRegion, toneWords: row.toneWords, emojiPolicy: row.emojiPolicy as EmojiPolicy,
    signaturePhrases: row.signaturePhrases, bannedPhrases: row.bannedPhrases, ctaExamples: row.ctaExamples,
    voiceNotes: row.voiceNotes, colors: row.colors ?? {}, headlineFont: row.headlineFont,
    logo: image(row.logoFileId, urls.logo), favicon: image(row.faviconFileId, urls.favicon), mascot: image(row.mascotFileId, urls.mascot),
    sourceType: row.sourceType as BrandRecord['sourceType'], sourceValue: row.sourceValue,
    importStatus: effectiveImportStatus(row, now).status,
    importedAt: row.importedAt ? row.importedAt.toISOString() : null,
    ready: missing.length === 0, missing,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The columns an import result writes: skips user-edited and empty fields; keeps only verbatim signature phrases. */
export function mergeImport(row: CreativeBrand, fill: BrandFill, sourceText: string): Partial<NewCreativeBrand> {
  const edited = new Set(row.editedByUser);
  const haystack = sourceText.toLowerCase();
  const values: Record<string, unknown> = {
    ...fill,
    signaturePhrases: fill.signaturePhrases.filter((p) => haystack.includes(p.toLowerCase())),
  };
  const out: Record<string, unknown> = {};
  for (const key of FILL_KEYS) {
    if (edited.has(key)) continue;
    const v = values[key];
    if (isEmpty(v)) continue;
    out[key] = v;
  }
  return out as Partial<NewCreativeBrand>;
}

export async function getBrandRow(tenantId: string): Promise<CreativeBrand | null> {
  const [row] = await db.select().from(creativeBrand).where(eq(creativeBrand.tenantId, tenantId)).limit(1);
  return row ?? null;
}

export async function getBrand(tenantId: string): Promise<BrandRecord | null> {
  const row = await getBrandRow(tenantId);
  if (!row) return null;
  const url = async (fileId: string | null) => {
    if (!fileId) return null;
    try { return await storageService.getDownloadUrl(tenantId, fileId); } catch { return null; }
  };
  const [logo, favicon, mascot] = await Promise.all([url(row.logoFileId), url(row.faviconFileId), url(row.mascotFileId)]);
  return toBrandRecord(row, { logo, favicon, mascot });
}

export async function startImport(tenantId: string, userId: string, source: { type: 'website' | 'instagram'; value: string }): Promise<void> {
  const now = new Date();
  const fields = {
    sourceType: source.type, sourceValue: source.value, importStatus: 'importing',
    importError: null, importStartedAt: now,
  };
  await db.insert(creativeBrand)
    .values({ tenantId, createdBy: userId, ...fields })
    .onConflictDoUpdate({ target: creativeBrand.tenantId, set: fields });
}

export async function markImportFailed(tenantId: string, reason: string): Promise<void> {
  await db.update(creativeBrand)
    .set({ importStatus: 'failed', importError: reason.slice(0, 500) })
    .where(eq(creativeBrand.tenantId, tenantId));
}

/** Saves the user's fields and records them in edited_by_user. Creates the row (source 'chat') if none. */
export async function patchBrand(tenantId: string, userId: string, patch: BrandPatch): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const existing = await getBrandRow(tenantId);
  // Image keys are stored under the image name ('logo'), the rest under their own name.
  const editedKeys = keys.map((k) => k.replace(/FileId$/, ''));
  const editedByUser = Array.from(new Set([...(existing?.editedByUser ?? []), ...editedKeys]));
  if (!existing) {
    await db.insert(creativeBrand)
      .values({ tenantId, createdBy: userId, sourceType: 'chat', ...patch, editedByUser })
      .onConflictDoUpdate({ target: creativeBrand.tenantId, set: { ...patch, editedByUser } });
    return;
  }
  await db.update(creativeBrand).set({ ...patch, editedByUser }).where(eq(creativeBrand.tenantId, tenantId));
}

/** Applies an import result unless the row moved on (a newer import, or none running). */
export async function applyImportResult(
  tenantId: string, fill: BrandFill, sourceText: string,
  images: { logoFileId?: string; faviconFileId?: string },
): Promise<'applied' | 'ignored'> {
  const row = await getBrandRow(tenantId);
  if (!row || row.importStatus !== 'importing') return 'ignored';
  const edited = new Set(row.editedByUser);
  const set: Partial<NewCreativeBrand> = {
    ...mergeImport(row, fill, sourceText),
    ...(images.logoFileId && !edited.has('logo') ? { logoFileId: images.logoFileId } : {}),
    ...(images.faviconFileId && !edited.has('favicon') ? { faviconFileId: images.faviconFileId } : {}),
    importStatus: 'done', importError: null, importedAt: new Date(),
  };
  await db.update(creativeBrand).set(set)
    .where(and(eq(creativeBrand.tenantId, tenantId), eq(creativeBrand.importStatus, 'importing')));
  return 'applied';
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run __tests__/brandRecords.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/lib/brandSchema.ts products/agent-platform/packages/api/lib/brandRecords.ts products/agent-platform/packages/api/__tests__/brandRecords.test.ts
git commit -m "feat(agent-api): brand record, readiness, stale-import and merge rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Move the guarded fetch out of the product import

**Files:**
- Create: `products/agent-platform/packages/api/lib/safeFetch.ts`
- Modify: `products/agent-platform/packages/api/routes/products.import.ts`
- Test: existing `__tests__/products.import.test.ts` (must still pass unchanged)

**Interfaces:**
- Produces from `lib/safeFetch.ts`:
  - `createDeadline(timeoutMs: number): { signal: AbortSignal; dispose: () => void }`
  - `guardedFetch(rawUrl: string, signal: AbortSignal): Promise<Response>`
  - `readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer>`
  - `importOneImage(imageUrl: string, tenantId: string, userId: string, prefix: string): Promise<ImportedImage | null>`
  - `interface ImportedImage { fileId: string; name: string; type: string; size: number }`
  - `fetchText(url: string, opts: { timeoutMs: number; maxBytes: number; accept: (contentType: string) => boolean }): Promise<{ text: string; finalUrl: string } | null>` (new small helper: guarded fetch + type check + capped read; `null` on any failure, error logged)

- [ ] **Step 1: Create `lib/safeFetch.ts`**

Move these from `routes/products.import.ts` **verbatim, with their comments**: `MAX_REDIRECTS`, `MAX_IMAGE_BYTES`, `IMAGE_FETCH_TIMEOUT_MS`, `ALLOWED_IMAGE_TYPES`, `createDeadline`, `guardedFetch`, `readCapped`, `ImportedImage`, `safeFilename`, `importOneImage`. Export the functions and `ImportedImage`. Change `importOneImage` to take the key prefix as a fourth parameter:

```ts
export async function importOneImage(
  imageUrl: string,
  tenantId: string,
  userId: string,
  prefix: string,
): Promise<ImportedImage | null> {
  // body unchanged except: const key = `${prefix}${crypto.randomUUID()}-${filename}`;
}
```

Add `fetchText` at the end:

```ts
/** One guarded GET for a text resource. Null on any failure (logged, never thrown). */
export async function fetchText(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; accept: (contentType: string) => boolean },
): Promise<{ text: string; finalUrl: string } | null> {
  const deadline = createDeadline(opts.timeoutMs);
  try {
    const response = await guardedFetch(url, deadline.signal);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !opts.accept(contentType)) {
      console.warn('[safeFetch] unreadable response', { url, status: response.status, contentType });
      return null;
    }
    const body = await readCapped(response, opts.maxBytes, deadline.signal);
    return { text: body.toString('utf8'), finalUrl: response.url || url };
  } catch (error) {
    console.warn('[safeFetch] fetch failed', { url, error: (error as Error).message });
    return null;
  } finally {
    deadline.dispose();
  }
}
```

The file needs these imports (from the route's current imports):

```ts
import { storageService } from '@serverless-saas/storage';
import { assertPublicHttpUrl, SsrfBlockedError } from '@serverless-saas/agent-worker-handlers/lib/ssrf-guard';
```

- [ ] **Step 2: Point the product import at it**

In `routes/products.import.ts`, delete the moved code and import it:

```ts
import { createDeadline, guardedFetch, importOneImage, readCapped, type ImportedImage } from '../lib/safeFetch';
```

Change the one call to `importOneImage(imageUrl, tenantId, userId, IMPORTED_IMAGE_PREFIX)`. Keep `MAX_PAGE_BYTES`, `PAGE_FETCH_TIMEOUT_MS`, `REQUEST_BUDGET_MS`, `MAX_CONCURRENT_IMAGE_FETCHES` and `IMPORTED_IMAGE_PREFIX` in the route. Remove imports that become unused.

- [ ] **Step 3: Run the product tests**

Run: `npx vitest run __tests__/products.import.test.ts __tests__/products.routes.test.ts`
Expected: PASS, same count as before the change. If `products.import.test.ts` mocks `assertPublicHttpUrl` or `storageService` by module path, the mocks still apply because the module ids are unchanged; if any test fails, fix the move, not the test.

- [ ] **Step 4: Commit**

```bash
git add products/agent-platform/packages/api/lib/safeFetch.ts products/agent-platform/packages/api/routes/products.import.ts
git commit -m "refactor(agent-api): guarded fetch and image import move to lib/safeFetch for reuse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Website facts extractor

**Files:**
- Modify: `products/agent-platform/packages/api/lib/productPageExtract.ts` (export `jsonLdCandidates`)
- Create: `products/agent-platform/packages/api/lib/brandPageExtract.ts`
- Test: `products/agent-platform/packages/api/__tests__/brandPageExtract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WebsiteFacts {
    url: string; siteName: string | null; title: string | null; description: string | null;
    headings: string[]; ctas: string[]; bodyText: string;
    logoCandidates: string[]; iconUrls: string[];
    themeColor: string | null; cssColors: string[]; fonts: string[];
    stylesheetUrl: string | null;
  }
  export function extractBrandPage(html: string, pageUrl: string, css?: string): WebsiteFacts
  export function sourceTextOf(facts: WebsiteFacts): string
  ```
  `logoCandidates` holds raster URLs only (no `.svg`), best first. `cssColors` holds `#RRGGBB` values, most frequent first, at most 12, excluding pure white and black unless nothing else exists. `fonts` holds family names without quotes or generic fallbacks, at most 3. `bodyText` is capped at 3000 characters.

- [ ] **Step 1: Export `jsonLdCandidates`**

In `productPageExtract.ts` change `function jsonLdCandidates(` to `export function jsonLdCandidates(`.

- [ ] **Step 2: Write the failing tests**

```ts
// products/agent-platform/packages/api/__tests__/brandPageExtract.test.ts
import { describe, it, expect } from 'vitest';
import { extractBrandPage, sourceTextOf } from '../lib/brandPageExtract';

const URL_ = 'https://mamaearth.example/';
const html = `<html><head>
  <title>Mamaearth | Toxin-free</title>
  <meta property="og:site_name" content="Mamaearth">
  <meta name="description" content="Natural skincare for India.">
  <meta name="theme-color" content="#00A651">
  <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple.png">
  <link rel="stylesheet" href="/main.css">
  <script type="application/ld+json">{"@type":"Organization","name":"Mamaearth","logo":"https://cdn.example/logo.png"}</script>
  <style>:root{--brand:#00a651;--ink:#1A1A1A} .x{color:#00A651}</style>
</head><body>
  <h1>Goodness Inside</h1><h2>Made safe for you</h2>
  <a class="btn" href="/shop">Shop now</a><button>Add to cart</button><a href="/about">About us</a>
  <img src="/brand-logo.svg" alt="Mamaearth logo">
  <p>Every product is toxin-free.</p>
</body></html>`;

describe('extractBrandPage', () => {
  it('reads name, description, headings and calls to action', () => {
    const f = extractBrandPage(html, URL_);
    expect(f.siteName).toBe('Mamaearth');
    expect(f.description).toBe('Natural skincare for India.');
    expect(f.headings).toEqual(['Goodness Inside', 'Made safe for you']);
    expect(f.ctas).toEqual(expect.arrayContaining(['Shop now', 'Add to cart']));
    expect(f.ctas).not.toContain('About us');
  });

  it('puts the JSON-LD logo first and never offers an SVG', () => {
    const f = extractBrandPage(html, URL_);
    expect(f.logoCandidates[0]).toBe('https://cdn.example/logo.png');
    expect(f.logoCandidates.some((u) => u.endsWith('.svg'))).toBe(false);
    expect(f.iconUrls).toEqual(['https://mamaearth.example/apple.png', 'https://mamaearth.example/favicon.ico']);
  });

  it('collects theme colour, CSS colours by frequency and fonts from linked CSS', () => {
    const f = extractBrandPage(html, URL_, `body{font-family:"Poppins", Arial, sans-serif} h1{color:#F7B500}`);
    expect(f.themeColor).toBe('#00A651');
    expect(f.cssColors[0]).toBe('#00A651');
    expect(f.cssColors).toContain('#F7B500');
    expect(f.fonts).toEqual(['Poppins', 'Arial']);
    expect(f.stylesheetUrl).toBe('https://mamaearth.example/main.css');
  });

  it('copes with an empty page', () => {
    const f = extractBrandPage('<html></html>', URL_);
    expect(f).toMatchObject({ siteName: null, headings: [], logoCandidates: [], cssColors: [], fonts: [] });
  });
});

describe('sourceTextOf', () => {
  it('joins every visible text field for the verbatim phrase check', () => {
    const text = sourceTextOf(extractBrandPage(html, URL_));
    expect(text).toContain('Goodness Inside');
    expect(text).toContain('toxin-free');
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run __tests__/brandPageExtract.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `brandPageExtract.ts`**

```ts
// products/agent-platform/packages/api/lib/brandPageExtract.ts
import { load } from 'cheerio';
import { jsonLdCandidates } from './productPageExtract';

export interface WebsiteFacts {
  url: string; siteName: string | null; title: string | null; description: string | null;
  headings: string[]; ctas: string[]; bodyText: string;
  logoCandidates: string[]; iconUrls: string[];
  themeColor: string | null; cssColors: string[]; fonts: string[];
  stylesheetUrl: string | null;
}

const MAX_BODY_TEXT = 3000;
const MAX_HEADINGS = 12;
const MAX_CTAS = 10;
const MAX_COLORS = 12;
const MAX_FONTS = 3;
// Button-ish text: short, and either inside a button or a link styled/labelled as one.
const CTA_WORDS = /\b(shop|buy|order|add to cart|get|try|start|book|subscribe|sign up|join|claim|download|dm|comment|call|whatsapp|explore)\b/i;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'ui-serif']);
const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const nonEmpty = (s: string | undefined | null) => clean(s) || null;

function resolve(candidate: string | undefined, base: string): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function normaliseHex(raw: string): string {
  const h = raw.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return `#${full.toUpperCase()}`;
}

function rankColors(css: string): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(HEX_RE)) {
    const hex = normaliseHex(m[0]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const coloured = ranked.filter((h) => h !== '#FFFFFF' && h !== '#000000');
  return (coloured.length > 0 ? coloured : ranked).slice(0, MAX_COLORS);
}

function rankFonts(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/["']/g, '').replace(/!important/i, '').trim();
      if (!name || GENERIC_FONTS.has(name.toLowerCase()) || name.startsWith('var(')) continue;
      if (!out.includes(name)) out.push(name);
      if (out.length >= MAX_FONTS) return out;
    }
  }
  return out;
}

function jsonLdLogo(candidates: unknown[]): { logo: string | null; name: string | null } {
  for (const c of candidates) {
    const node = c as { '@type'?: unknown; logo?: unknown; name?: unknown } | null;
    const type = node?.['@type'];
    const isOrg = type === 'Organization' || type === 'Brand' || (Array.isArray(type) && type.includes('Organization'));
    if (!isOrg) continue;
    const logo = typeof node?.logo === 'string' ? node.logo
      : typeof (node?.logo as { url?: unknown })?.url === 'string' ? (node!.logo as { url: string }).url : null;
    return { logo, name: typeof node?.name === 'string' ? node.name : null };
  }
  return { logo: null, name: null };
}

export function extractBrandPage(html: string, pageUrl: string, css = ''): WebsiteFacts {
  const $ = load(html);
  const meta = (sel: string) => nonEmpty($(sel).attr('content'));
  const org = jsonLdLogo(jsonLdCandidates($));

  const headings = $('h1, h2, h3').toArray().map((el) => clean($(el).text())).filter((t) => t && t.length <= 120).slice(0, MAX_HEADINGS);

  const ctas: string[] = [];
  $('button, a, input[type=submit]').each((_, el) => {
    const text = clean($(el).text() || $(el).attr('value'));
    if (!text || text.length > 40 || ctas.includes(text)) return;
    const isButton = el.tagName === 'button' || el.tagName === 'input' || /btn|button|cta/i.test($(el).attr('class') ?? '');
    if (isButton || CTA_WORDS.test(text)) ctas.push(text);
  });

  const imgLogos = $('img').toArray()
    .filter((el) => /logo/i.test(`${$(el).attr('alt') ?? ''} ${$(el).attr('src') ?? ''} ${$(el).attr('class') ?? ''}`))
    .map((el) => resolve($(el).attr('src'), pageUrl));
  const logoCandidates = [resolve(org.logo ?? undefined, pageUrl), ...imgLogos]
    .filter((u): u is string => !!u && !/\.svg(\?|$)/i.test(u))
    .filter((u, i, a) => a.indexOf(u) === i);

  const iconUrls = [
    ...$('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').toArray(),
    ...$('link[rel="icon"], link[rel="shortcut icon"]').toArray(),
  ].map((el) => resolve($(el).attr('href'), pageUrl))
    .filter((u): u is string => !!u && !/\.svg(\?|$)/i.test(u))
    .filter((u, i, a) => a.indexOf(u) === i);

  const inlineCss = $('style').toArray().map((el) => $(el).text()).join('\n');
  const allCss = `${inlineCss}\n${css}`;
  const themeRaw = meta('meta[name="theme-color"]');
  const themeColor = themeRaw && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(themeRaw) ? normaliseHex(themeRaw) : null;

  $('script, style, noscript, svg').remove();
  const bodyText = clean($('body').text()).slice(0, MAX_BODY_TEXT);

  return {
    url: pageUrl,
    siteName: meta('meta[property="og:site_name"]') ?? org.name,
    title: nonEmpty($('title').first().text()),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    headings, ctas: ctas.slice(0, MAX_CTAS), bodyText,
    logoCandidates, iconUrls,
    themeColor, cssColors: rankColors(allCss), fonts: rankFonts(allCss),
    stylesheetUrl: resolve($('link[rel="stylesheet"]').first().attr('href'), pageUrl),
  };
}

/** Every visible text field, for the verbatim signature-phrase check. */
export function sourceTextOf(f: WebsiteFacts): string {
  return [f.siteName, f.title, f.description, ...f.headings, ...f.ctas, f.bodyText].filter(Boolean).join('\n');
}
```

Note: `extractBrandPage` reads `$('style')` before removing styles for `bodyText`; keep that order.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run __tests__/brandPageExtract.test.ts __tests__/productPageExtract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/lib/productPageExtract.ts products/agent-platform/packages/api/lib/brandPageExtract.ts products/agent-platform/packages/api/__tests__/brandPageExtract.test.ts
git commit -m "feat(agent-api): read brand facts from a website — name, CTAs, logo, colours, fonts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Brand routes — read, edit, start an import

**Files:**
- Create: `products/agent-platform/packages/api/lib/brandSource.ts`
- Create: `products/agent-platform/packages/api/lib/brandImport.ts`
- Create: `products/agent-platform/packages/api/routes/brand.ts`
- Modify: `products/agent-platform/packages/api/index.ts` (mount `/brand` after `/products`)
- Test: `products/agent-platform/packages/api/__tests__/brandSource.test.ts`, `__tests__/brand.routes.test.ts`

**Interfaces:**
- Consumes: Task 2 (`getBrand`, `startImport`, `markImportFailed`, `patchBrand`, `brandPatchSchema`), Task 3 (`fetchText`), Task 4 (`extractBrandPage`, `WebsiteFacts`).
- Produces:
  - `parseBrandSource(value: string): { type: 'website'; url: string } | { type: 'instagram'; handle: string } | null`
  - `runBrandImport(tenantId: string, userId: string, source): Promise<void>` (never throws; sets `failed` on any failure)
  - Routes: `GET /brand` → `{ data: BrandRecord | null }`; `PATCH /brand` (body `BrandPatch`) → `{ data: BrandRecord }`; `POST /brand/import` (body `{ value: string }`) → `202 { data: BrandRecord }`, `400` for unrecognised input.
  - Orchestrator request body (consumed by Task 7): `POST {AGENT_ORCHESTRATOR_URL}/internal/brand/import`, header `X-Service-Key`, JSON `{ tenantId: string; source: 'website' | 'instagram'; handle?: string; facts?: WebsiteFacts }`, expects `202`.

- [ ] **Step 1: Write the failing source-detection test**

```ts
// products/agent-platform/packages/api/__tests__/brandSource.test.ts
import { describe, it, expect } from 'vitest';
import { parseBrandSource } from '../lib/brandSource';

describe('parseBrandSource', () => {
  it.each([
    ['@mamaearth.in', 'mamaearth.in'],
    ['mamaearth_in', 'mamaearth_in'],
    ['https://www.instagram.com/mamaearth.in/?hl=en', 'mamaearth.in'],
    ['instagram.com/Pilgrim', 'pilgrim'],
  ])('reads %s as Instagram', (value, handle) => {
    expect(parseBrandSource(value)).toEqual({ type: 'instagram', handle });
  });

  it.each([
    ['https://mamaearth.in', 'https://mamaearth.in/'],
    ['mamaearth.in', 'https://mamaearth.in/'],
    ['http://shop.example.com/x', 'https://shop.example.com/x'],
  ])('reads %s as a website', (value, url) => {
    expect(parseBrandSource(value)).toEqual({ type: 'website', url });
  });

  it.each(['', '   ', 'hello world', 'ftp://x.com', '@', 'https://instagram.com/'])('rejects %j', (value) => {
    expect(parseBrandSource(value)).toBeNull();
  });
});
```

Note: a bare word with no dot (`mamaearth_in`) is an Instagram handle; a word with a dot and a TLD-looking end (`mamaearth.in`) is a website. `@mamaearth.in` is Instagram because of the `@`.

- [ ] **Step 2: Run to see it fail, then write `brandSource.ts`**

Run: `npx vitest run __tests__/brandSource.test.ts` → FAIL (module not found).

```ts
// products/agent-platform/packages/api/lib/brandSource.ts
const HANDLE = /^[a-z0-9._]{1,30}$/;
const IG_HOST = /^(www\.)?instagram\.com$/i;

export type BrandSource = { type: 'website'; url: string } | { type: 'instagram'; handle: string };

/** One input box, two kinds of link: an Instagram handle/profile URL, or a website. */
export function parseBrandSource(raw: string): BrandSource | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith('@')) {
    const handle = value.slice(1).toLowerCase();
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL | null = null;
  try { url = new URL(withScheme); } catch { url = null; }

  if (url && IG_HOST.test(url.hostname)) {
    const handle = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  if (!value.includes('.') && !value.includes('/')) {
    const handle = value.toLowerCase();
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  url.protocol = 'https:';
  return { type: 'website', url: url.href };
}
```

Run again: PASS.

- [ ] **Step 3: Write `brandImport.ts`**

```ts
// products/agent-platform/packages/api/lib/brandImport.ts
import { fetchText } from './safeFetch';
import { extractBrandPage, type WebsiteFacts } from './brandPageExtract';
import { markImportFailed, startImport } from './brandRecords';
import type { BrandSource } from './brandSource';

// The whole request stays under the web proxy's 15 s abort: page 7 s + CSS 2 s + ack 3 s.
const PAGE_TIMEOUT_MS = 7000;
const CSS_TIMEOUT_MS = 2000;
const ORCHESTRATOR_ACK_TIMEOUT_MS = 3000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 512 * 1024;

async function readWebsite(url: string): Promise<WebsiteFacts | null> {
  const page = await fetchText(url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES, accept: (t) => t.includes('text/html') });
  if (!page) return null;
  const first = extractBrandPage(page.text, page.finalUrl);
  if (!first.stylesheetUrl) return first;
  const css = await fetchText(first.stylesheetUrl, { timeoutMs: CSS_TIMEOUT_MS, maxBytes: MAX_CSS_BYTES, accept: (t) => t.includes('css') });
  return css ? extractBrandPage(page.text, page.finalUrl, css.text) : first;
}

async function askOrchestrator(body: { tenantId: string; source: BrandSource['type']; handle?: string; facts?: WebsiteFacts }): Promise<boolean> {
  const baseUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error('[brandImport] AGENT_ORCHESTRATOR_URL or INTERNAL_SERVICE_KEY not set');
    return false;
  }
  try {
    const res = await fetch(`${baseUrl}/internal/brand/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ORCHESTRATOR_ACK_TIMEOUT_MS),
    });
    if (res.status !== 202) console.error('[brandImport] orchestrator returned', res.status, { tenantId: body.tenantId });
    return res.status === 202;
  } catch (error) {
    console.error('[brandImport] orchestrator unreachable', { tenantId: body.tenantId, error: (error as Error).message });
    return false;
  }
}

/** Marks the row importing and hands the work to the orchestrator. Never throws. */
export async function runBrandImport(tenantId: string, userId: string, source: BrandSource): Promise<void> {
  const value = source.type === 'website' ? source.url : `@${source.handle}`;
  await startImport(tenantId, userId, { type: source.type, value });
  try {
    if (source.type === 'website') {
      const facts = await readWebsite(source.url);
      if (!facts) return markImportFailed(tenantId, 'website could not be read');
      if (!(await askOrchestrator({ tenantId, source: 'website', facts }))) return markImportFailed(tenantId, 'orchestrator did not accept the import');
      return;
    }
    if (!(await askOrchestrator({ tenantId, source: 'instagram', handle: source.handle }))) {
      return markImportFailed(tenantId, 'orchestrator did not accept the import');
    }
  } catch (error) {
    console.error('[brandImport] failed', { tenantId, error: (error as Error).message });
    await markImportFailed(tenantId, 'import failed');
  }
}
```

- [ ] **Step 4: Write the failing route tests**

```ts
// products/agent-platform/packages/api/__tests__/brand.routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lib = { getBrand: vi.fn(), patchBrand: vi.fn() };
vi.mock('../lib/brandRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/brandRecords')>()),
  getBrand: (...a: unknown[]) => lib.getBrand(...a),
  patchBrand: (...a: unknown[]) => lib.patchBrand(...a),
}));
const runBrandImport = vi.fn();
vi.mock('../lib/brandImport', () => ({ runBrandImport: (...a: unknown[]) => runBrandImport(...a) }));
const fileOwned = vi.fn();
vi.mock('../lib/brandFiles', () => ({ filesBelongToTenant: (...a: unknown[]) => fileOwned(...a) }));
vi.mock('../db', () => ({ db: {} }));

const F1 = '11111111-1111-4111-8111-111111111111';
const record = { name: 'Mamaearth', importStatus: 'done' };

async function app(permissions = [{ resource: 'files', action: 'read' }, { resource: 'files', action: 'create' }]) {
  const { brandRoutes } = await import('../routes/brand');
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('requestContext' as never, { tenant: { id: 'tenant-1' }, permissions } as never);
    c.set('userId' as never, 'user-1' as never);
    await next();
  });
  a.route('/brand', brandRoutes);
  return a;
}
const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); lib.getBrand.mockResolvedValue(record); fileOwned.mockResolvedValue(true); });

describe('/brand routes', () => {
  it('GET returns null data when there is no brand', async () => {
    lib.getBrand.mockResolvedValue(null);
    const res = await (await app()).request('/brand');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('PATCH validates and saves for this tenant only', async () => {
    const res = await (await app()).request('/brand', send('PATCH', { name: 'New', toneWords: ['warm'] }));
    expect(res.status).toBe(200);
    expect(lib.patchBrand).toHaveBeenCalledWith('tenant-1', 'user-1', { name: 'New', toneWords: ['warm'] });
  });

  it('PATCH rejects a logo file from another workspace', async () => {
    fileOwned.mockResolvedValue(false);
    const res = await (await app()).request('/brand', send('PATCH', { logoFileId: F1 }));
    expect(res.status).toBe(400);
    expect(lib.patchBrand).not.toHaveBeenCalled();
  });

  it('PATCH needs create permission', async () => {
    const res = await (await app([{ resource: 'files', action: 'read' }])).request('/brand', send('PATCH', { name: 'X' }));
    expect(res.status).toBe(403);
  });

  it('POST /import starts an Instagram import and returns 202', async () => {
    const res = await (await app()).request('/brand/import', send('POST', { value: '@mamaearth.in' }));
    expect(res.status).toBe(202);
    expect(runBrandImport).toHaveBeenCalledWith('tenant-1', 'user-1', { type: 'instagram', handle: 'mamaearth.in' });
  });

  it('POST /import rejects input that is neither a site nor a handle', async () => {
    const res = await (await app()).request('/brand/import', send('POST', { value: 'hello world' }));
    expect(res.status).toBe(400);
    expect(runBrandImport).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Write `lib/brandFiles.ts` and `routes/brand.ts`**

```ts
// products/agent-platform/packages/api/lib/brandFiles.ts
import { and, eq, inArray } from 'drizzle-orm';
import { files } from '@serverless-saas/database/schema/files';
import { db } from '../db';

/** True when every id is a files row of this tenant (a logo can't point at another workspace's file). */
export async function filesBelongToTenant(tenantId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const rows = await db.select({ id: files.id }).from(files).where(and(eq(files.tenantId, tenantId), inArray(files.id, ids)));
  return rows.length === new Set(ids).size;
}
```

(Use the same `files` import path you confirmed in Task 1.)

```ts
// products/agent-platform/packages/api/routes/brand.ts
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import { brandPatchSchema } from '../lib/brandSchema';
import { getBrand, patchBrand } from '../lib/brandRecords';
import { parseBrandSource } from '../lib/brandSource';
import { runBrandImport } from '../lib/brandImport';
import { filesBelongToTenant } from '../lib/brandFiles';

export const brandRoutes = new Hono<AppEnv>();

// Brand images are Drive files, so the brand follows the files permissions, like products.
function guard(c: Context<AppEnv>, action: 'read' | 'create'): { tenantId: string; userId: string } | Response {
  const requestContext = c.get('requestContext') as any;
  const tenantId: string | undefined = requestContext?.tenant?.id;
  const userId = c.get('userId') as string | undefined;
  if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  if (!userId) return c.json({ error: 'Forbidden', message: 'Missing userId' }, 403);
  if (!hasPermission(requestContext?.permissions ?? [], 'files', action)) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }
  return { tenantId, userId };
}

brandRoutes.get('/', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: await getBrand(g.tenantId) });
});

brandRoutes.patch('/', zValidator('json', brandPatchSchema), async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const patch = c.req.valid('json');
  const fileIds = [patch.logoFileId, patch.faviconFileId, patch.mascotFileId].filter((v): v is string => typeof v === 'string');
  if (!(await filesBelongToTenant(g.tenantId, fileIds))) {
    return c.json({ error: 'Invalid file', message: 'That image is not in this workspace' }, 400);
  }
  await patchBrand(g.tenantId, g.userId, patch);
  return c.json({ data: await getBrand(g.tenantId) });
});

brandRoutes.post('/import', zValidator('json', z.object({ value: z.string().max(500) })), async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const source = parseBrandSource(c.req.valid('json').value);
  if (!source) return c.json({ error: 'Import failed', message: 'Paste a website link or an Instagram handle' }, 400);
  await runBrandImport(g.tenantId, g.userId, source);
  return c.json({ data: await getBrand(g.tenantId) }, 202);
});
```

- [ ] **Step 6: Mount the routes**

In `products/agent-platform/packages/api/index.ts` add `import { brandRoutes } from './routes/brand';` with the other route imports, and inside `mountApiRoutes`, after `api.route('/products', productsRoutes);`:

```ts
    api.route('/brand', brandRoutes);
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run __tests__/brandSource.test.ts __tests__/brand.routes.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add products/agent-platform/packages/api/lib/brandSource.ts products/agent-platform/packages/api/lib/brandImport.ts products/agent-platform/packages/api/lib/brandFiles.ts products/agent-platform/packages/api/routes/brand.ts products/agent-platform/packages/api/index.ts products/agent-platform/packages/api/__tests__/brandSource.test.ts products/agent-platform/packages/api/__tests__/brand.routes.test.ts
git commit -m "feat(agent-api): /brand read, edit and import from a website or Instagram handle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Internal import-result route

**Files:**
- Create: `products/agent-platform/packages/api/routes/internal/brand.ts`
- Modify: `products/agent-platform/packages/api/index.ts` (mount in `mountInternalRoutes`)
- Test: `products/agent-platform/packages/api/__tests__/internal.brand.test.ts`

**Interfaces:**
- Consumes: `applyImportResult`, `markImportFailed`, `getBrandRow` (Task 2), `brandFillSchema` (Task 2), `importOneImage` (Task 3), `isAuthorized` from `routes/internal/tasks.auth`.
- Produces: `POST /api/v1/internal/brand/import-result`, header `x-internal-service-key`, body either
  `{ tenantId: string; ok: true; fields: BrandFill; sourceText: string; logoUrl?: string; faviconUrl?: string }`
  or `{ tenantId: string; ok: false; error: string }`. Returns `200 { result: 'applied' | 'ignored' | 'failed' }`, `401` without the key.

- [ ] **Step 1: Write the failing test**

```ts
// products/agent-platform/packages/api/__tests__/internal.brand.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const rec = { applyImportResult: vi.fn(), markImportFailed: vi.fn(), getBrandRow: vi.fn() };
vi.mock('../lib/brandRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/brandRecords')>()),
  applyImportResult: (...a: unknown[]) => rec.applyImportResult(...a),
  markImportFailed: (...a: unknown[]) => rec.markImportFailed(...a),
  getBrandRow: (...a: unknown[]) => rec.getBrandRow(...a),
}));
const importOneImage = vi.fn();
vi.mock('../lib/safeFetch', () => ({ importOneImage: (...a: unknown[]) => importOneImage(...a) }));
vi.mock('../db', () => ({ db: {} }));

const T = '11111111-1111-4111-8111-111111111111';
async function app() {
  process.env.INTERNAL_SERVICE_KEY = 'k';
  const { internalBrandRoute } = await import('../routes/internal/brand');
  const a = new Hono();
  a.route('/internal/brand', internalBrandRoute);
  return a;
}
const post = (body: unknown, key = 'k') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-key': key }, body: JSON.stringify(body) });
const fields = { name: 'Mamaearth', toneWords: ['warm'], region: 'IN', emojiPolicy: 'minimal' };

beforeEach(() => {
  vi.clearAllMocks();
  rec.getBrandRow.mockResolvedValue({ importStatus: 'importing', createdBy: 'user-1' });
  rec.applyImportResult.mockResolvedValue('applied');
});

describe('POST /internal/brand/import-result', () => {
  it('refuses a call without the service key', async () => {
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: false, error: 'x' }, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('saves the logo to Drive under brand/ and applies the fields', async () => {
    importOneImage.mockResolvedValueOnce({ fileId: 'logo-file' });
    const res = await (await app()).request('/internal/brand/import-result',
      post({ tenantId: T, ok: true, fields, sourceText: 'Mamaearth', logoUrl: 'https://cdn.example/logo.png' }));
    expect(res.status).toBe(200);
    expect(importOneImage).toHaveBeenCalledWith('https://cdn.example/logo.png', T, 'user-1', 'brand/');
    expect(rec.applyImportResult).toHaveBeenCalledWith(T, expect.objectContaining({ name: 'Mamaearth' }), 'Mamaearth', { logoFileId: 'logo-file', faviconFileId: undefined });
  });

  it('still applies the text fields when the logo cannot be saved', async () => {
    importOneImage.mockRejectedValueOnce(new Error('403'));
    await (await app()).request('/internal/brand/import-result',
      post({ tenantId: T, ok: true, fields, sourceText: '', logoUrl: 'https://cdn.example/logo.png' }));
    expect(rec.applyImportResult).toHaveBeenCalledWith(T, expect.anything(), '', { logoFileId: undefined, faviconFileId: undefined });
  });

  it('ignores a result when no import is running (a newer edit or import won)', async () => {
    rec.getBrandRow.mockResolvedValue({ importStatus: 'done', createdBy: 'user-1' });
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: true, fields, sourceText: '' }));
    expect(await res.json()).toEqual({ result: 'ignored' });
    expect(importOneImage).not.toHaveBeenCalled();
    expect(rec.applyImportResult).not.toHaveBeenCalled();
  });

  it('marks the import failed on an error report', async () => {
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: false, error: 'gateway 500' }));
    expect(await res.json()).toEqual({ result: 'failed' });
    expect(rec.markImportFailed).toHaveBeenCalledWith(T, 'gateway 500');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run __tests__/internal.brand.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the route**

```ts
// products/agent-platform/packages/api/routes/internal/brand.ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@serverless-saas/types';
import { isAuthorized } from './tasks.auth';
import { brandFillSchema } from '../../lib/brandSchema';
import { applyImportResult, getBrandRow, markImportFailed } from '../../lib/brandRecords';
import { importOneImage } from '../../lib/safeFetch';

export const internalBrandRoute = new Hono<AppEnv>();

const BRAND_IMAGE_PREFIX = 'brand/';
const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'));

const bodySchema = z.discriminatedUnion('ok', [
  z.object({
    tenantId: z.string().uuid(), ok: z.literal(true), fields: brandFillSchema,
    sourceText: z.string().max(20_000).default(''),
    logoUrl: httpsUrl.optional(), faviconUrl: httpsUrl.optional(),
  }),
  z.object({ tenantId: z.string().uuid(), ok: z.literal(false), error: z.string().max(500) }),
]);

async function saveImage(url: string | undefined, tenantId: string, userId: string | null): Promise<string | undefined> {
  if (!url || !userId) return undefined;
  try {
    return (await importOneImage(url, tenantId, userId, BRAND_IMAGE_PREFIX))?.fileId;
  } catch (error) {
    console.warn('[internal.brand] image not saved', { tenantId, url, error: (error as Error).message });
    return undefined;
  }
}

internalBrandRoute.post('/import-result', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  if (!body.ok) {
    console.error('[internal.brand] import failed', { tenantId: body.tenantId, error: body.error });
    await markImportFailed(body.tenantId, body.error);
    return c.json({ result: 'failed' });
  }

  const row = await getBrandRow(body.tenantId);
  if (!row || row.importStatus !== 'importing') return c.json({ result: 'ignored' });

  const [logoFileId, faviconFileId] = await Promise.all([
    saveImage(body.logoUrl, body.tenantId, row.createdBy),
    saveImage(body.faviconUrl, body.tenantId, row.createdBy),
  ]);
  const result = await applyImportResult(body.tenantId, body.fields, body.sourceText, { logoFileId, faviconFileId });
  return c.json({ result });
});
```

- [ ] **Step 4: Mount it**

In `products/agent-platform/packages/api/index.ts` add `import { internalBrandRoute } from './routes/internal/brand';` and in `mountInternalRoutes`:

```ts
    internalApi.route('/internal/brand', internalBrandRoute);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run __tests__/internal.brand.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the whole API suite and type-check**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: only the two failures that exist on `origin/main` (`officialSkillsSeed.test.ts` "has every slug", `personas.test.ts` "stores exampleAssetUrl2…"); no new failures; no type errors.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/api/routes/internal/brand.ts products/agent-platform/packages/api/index.ts products/agent-platform/packages/api/__tests__/internal.brand.test.ts
git commit -m "feat(agent-api): internal import-result saves brand logo to Drive and merges fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Orchestrator — Instagram read, fill agent, import workflow, internal route

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/brand/types.ts`
- Create: `apps/agent-orchestrator/src/mastra/brand/tikhub.ts`
- Create: `apps/agent-orchestrator/src/mastra/agents/brandFillAgent.ts`
- Create: `apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.ts`
- Create: `apps/agent-orchestrator/src/routes/brandImport.ts`
- Modify: `apps/agent-orchestrator/src/mastra/index.ts` (register workflow `brandImport`)
- Modify: `apps/agent-orchestrator/src/app.ts` (mount router)
- Modify: `apps/agent-orchestrator/src/routes/productDescribe.ts` (export `downloadImageBase64`)
- Modify: `apps/agent-orchestrator/.env.example` (add `TIKHUB_API_KEY=`)
- Test: `apps/agent-orchestrator/src/mastra/brand/tikhub.test.ts`, `src/mastra/workflows/brandImportWorkflow.test.ts`, `src/routes/brandImport.test.ts`

**Interfaces:**
- Consumes: the API request body from Task 5 and the result body of Task 6.
- Produces:
  - `types.ts`: `WebsiteFacts` (same fields as Task 4), `InstagramFacts = { handle: string; fullName: string | null; bio: string | null; externalUrl: string | null; profilePicUrl: string | null; captions: string[] }`, `BrandFill` (same keys as Task 2's `brandFillSchema`), `TenantBrand` (used by Tasks 8 and 9):
    ```ts
    export interface TenantBrand {
      name: string | null; oneLiner: string | null; audience: string | null; region: string;
      toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[];
      ctaExamples: string[]; voiceNotes: string | null; colors: Record<string, string>;
      headlineFont: string | null; logoFileId: string | null;
    }
    ```
  - `tikhub.ts`: `fetchInstagramProfile(handle: string): Promise<InstagramFacts | null>`, `parseInstagramProfile(json: unknown, handle: string): InstagramFacts | null`
  - `brandFillAgent.ts`: `brandFillAgent` (Agent id `pc-brand-fill`), `brandFillOutputSchema` (Zod), `buildFillPrompt(input: { website?: WebsiteFacts; instagram?: InstagramFacts }): string`
  - `brandImportWorkflow.ts`: `brandImportWorkflow` (id `brand-import-workflow`), `reportImportResult(body): Promise<void>`
  - Route: `POST /internal/brand/import` → `202 { runId }`

- [ ] **Step 1: Record a real TikHub response as a fixture**

The response shape must come from a real call, not memory. With `TIKHUB_API_KEY` exported in your shell:

```bash
curl -s -H "Authorization: Bearer $TIKHUB_API_KEY" \
  "https://api.tikhub.io/api/v1/instagram/v1/fetch_user_info_by_username_v2?username=mamaearth.in" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d, indent=1)[:4000])"
```

Save the full JSON to `apps/agent-orchestrator/src/mastra/brand/__fixtures__/tikhub-user.json`. Find the paths to: full name, biography, external URL, HD profile picture URL, and the post captions. If the key is not available, ask the user for it before continuing this task; do not guess the shape. The parser below assumes the common shape `data.data.user.{full_name, biography, external_url, profile_pic_url_hd, edge_owner_to_timeline_media.edges[].node.edge_media_to_caption.edges[0].node.text}`; adjust the paths in `parseInstagramProfile` to match the fixture, and keep a fallback to `data.user` and `data` for the user object.

- [ ] **Step 2: Write the failing TikHub parser test**

```ts
// apps/agent-orchestrator/src/mastra/brand/tikhub.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInstagramProfile } from './tikhub.js'

const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/tikhub-user.json', import.meta.url), 'utf8'))

describe('parseInstagramProfile', () => {
  it('reads name, bio, picture and captions from a real response', () => {
    const p = parseInstagramProfile(fixture, 'mamaearth.in')
    expect(p?.handle).toBe('mamaearth.in')
    expect(p?.fullName).toBeTruthy()
    expect(p?.profilePicUrl).toMatch(/^https:\/\//)
    expect(p?.captions.length).toBeGreaterThan(0)
    expect(p!.captions.length).toBeLessThanOrEqual(12)
  })

  it('returns null for an empty or error response', () => {
    expect(parseInstagramProfile({}, 'x')).toBeNull()
    expect(parseInstagramProfile({ code: 400, data: null }, 'x')).toBeNull()
  })
})
```

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/brand/tikhub.test.ts` → FAIL.

- [ ] **Step 3: Write `types.ts` and `tikhub.ts`**

```ts
// apps/agent-orchestrator/src/mastra/brand/types.ts
// Shapes shared with the API (products/agent-platform/packages/api/lib/brandPageExtract.ts,
// brandSchema.ts). Kept in sync by hand: the two packages can't import each other.
export interface WebsiteFacts {
  url: string; siteName: string | null; title: string | null; description: string | null
  headings: string[]; ctas: string[]; bodyText: string
  logoCandidates: string[]; iconUrls: string[]
  themeColor: string | null; cssColors: string[]; fonts: string[]
  stylesheetUrl: string | null
}

export interface InstagramFacts {
  handle: string; fullName: string | null; bio: string | null; externalUrl: string | null
  profilePicUrl: string | null; captions: string[]
}

export interface BrandFill {
  name: string; oneLiner: string; audience: string; region: string; toneWords: string[]
  emojiPolicy: string; signaturePhrases: string[]; ctaExamples: string[]; voiceNotes: string
  colors: Record<string, string>; headlineFont: string
}

export interface TenantBrand {
  name: string | null; oneLiner: string | null; audience: string | null; region: string
  toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[]
  ctaExamples: string[]; voiceNotes: string | null; colors: Record<string, string>
  headlineFont: string | null; logoFileId: string | null
}
```

```ts
// apps/agent-orchestrator/src/mastra/brand/tikhub.ts
import type { InstagramFacts } from './types.js'

const TIKHUB_URL = 'https://api.tikhub.io/api/v1/instagram/v1/fetch_user_info_by_username_v2'
const TIMEOUT_MS = 15_000
const MAX_CAPTIONS = 12

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseInstagramProfile(json: unknown, handle: string): InstagramFacts | null {
  const d = (json as { data?: any })?.data
  const user = d?.data?.user ?? d?.user ?? (d?.username ? d : null)
  if (!user || typeof user !== 'object') return null
  const edges: any[] = user.edge_owner_to_timeline_media?.edges ?? []
  const captions = edges
    .map((e) => str(e?.node?.edge_media_to_caption?.edges?.[0]?.node?.text))
    .filter((c): c is string => !!c)
    .slice(0, MAX_CAPTIONS)
  const pic = str(user.profile_pic_url_hd) ?? str(user.profile_pic_url)
  return {
    handle,
    fullName: str(user.full_name),
    bio: str(user.biography),
    externalUrl: str(user.external_url),
    profilePicUrl: pic && pic.startsWith('https://') ? pic : null,
    captions,
  }
}

/** One TikHub call. Null on any failure (logged). Cost is TikHub's per-call price, logged by the caller. */
export async function fetchInstagramProfile(handle: string): Promise<InstagramFacts | null> {
  const key = process.env.TIKHUB_API_KEY
  if (!key) {
    console.error('[tikhub] TIKHUB_API_KEY not set')
    return null
  }
  try {
    const res = await fetch(`${TIKHUB_URL}?username=${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error('[tikhub] HTTP', res.status, { handle })
      return null
    }
    return parseInstagramProfile(await res.json(), handle)
  } catch (err) {
    console.error('[tikhub] failed', { handle, error: (err as Error).message })
    return null
  }
}
```

Run the test again: PASS. Add `TIKHUB_API_KEY=` with a one-line comment (`# Instagram brand import (tikhub.io)`) to `apps/agent-orchestrator/.env.example`.

- [ ] **Step 4: Write the fill agent**

First export the existing image downloader: in `src/routes/productDescribe.ts`, change `async function downloadImageBase64(` to `export async function downloadImageBase64(`.

```ts
// apps/agent-orchestrator/src/mastra/agents/brandFillAgent.ts
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { liteModel } from '../model.js'
import type { InstagramFacts, WebsiteFacts } from '../brand/types.js'

// No-tools utility agent for brandImportWorkflow — same pattern as
// skillDraftAgent/formatterAgent: one focused structured call, not an Olmo turn.
export const brandFillAgent = new Agent({
  id: 'pc-brand-fill',
  name: 'Brand Fill',
  instructions: `You read what a brand publishes about itself and describe the brand for the people who will write its ads.
Rules:
- Use only what the material shows. Never invent facts, awards, prices or claims.
- oneLiner: one plain sentence saying what the brand makes or sells. No marketing language.
- audience: who the brand is for, in plain words (age range, place, need) as the material suggests.
- region: IN, US, UK, AE, SG or GLOBAL, from the domain, currency, language and places mentioned. If unsure, IN.
- toneWords: 3 to 5 single adjectives for how the brand sounds.
- emojiPolicy: none, minimal, moderate or expressive, from how its own copy uses emoji.
- signaturePhrases: short phrases the brand repeats about itself, copied exactly as written. Leave empty if none repeat.
- ctaExamples: calls to action exactly as the brand writes them (button text, "comment X for the link").
- voiceNotes: a few short markdown bullets under "## What we say" and "## What we avoid".
- colors: hex values (#RRGGBB) for primary, secondary, accent, text, background, muted. Prefer the CSS colours and theme colour given; otherwise read them from the logo image. Leave a role as "" when unknown.
- headlineFont: the first real font family given, else "".
- Use "" or [] for anything the material does not show.`,
  tools: {},
  model: liteModel,
})

// String enums only: Gemini rejects numeric enums in response schemas.
export const brandFillOutputSchema = z.object({
  name: z.string(),
  oneLiner: z.string(),
  audience: z.string(),
  region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']),
  toneWords: z.array(z.string()),
  emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']),
  signaturePhrases: z.array(z.string()),
  ctaExamples: z.array(z.string()),
  voiceNotes: z.string(),
  colors: z.object({
    primary: z.string(), secondary: z.string(), accent: z.string(),
    text: z.string(), background: z.string(), muted: z.string(),
  }),
  headlineFont: z.string(),
})

const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '')

export function buildFillPrompt(input: { website?: WebsiteFacts; instagram?: InstagramFacts }): string {
  const parts: string[] = []
  const w = input.website
  if (w) {
    parts.push(
      `Website: ${w.url}`,
      w.siteName ? `Site name: ${w.siteName}` : '',
      w.title ? `Page title: ${w.title}` : '',
      w.description ? `Description: ${w.description}` : '',
      list('Headings', w.headings),
      list('Buttons and calls to action', w.ctas),
      w.themeColor ? `Theme colour: ${w.themeColor}` : '',
      list('CSS colours, most used first', w.cssColors),
      list('Fonts', w.fonts),
      w.bodyText ? `Page text:\n${w.bodyText}` : '',
    )
  }
  const ig = input.instagram
  if (ig) {
    parts.push(
      `Instagram: @${ig.handle}`,
      ig.fullName ? `Name: ${ig.fullName}` : '',
      ig.bio ? `Bio: ${ig.bio}` : '',
      ig.externalUrl ? `Link in bio: ${ig.externalUrl}` : '',
      list('Recent captions', ig.captions),
    )
  }
  parts.push('The attached image, if any, is the brand logo or profile picture.')
  return parts.filter(Boolean).join('\n\n')
}
```

- [ ] **Step 5: Write the failing workflow test**

```ts
// apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const generate = vi.fn()
vi.mock('../agents/brandFillAgent.js', async (orig) => ({
  ...(await orig<typeof import('../agents/brandFillAgent.js')>()),
  brandFillAgent: { generate: (...a: unknown[]) => generate(...a) },
}))
const fetchInstagramProfile = vi.fn()
vi.mock('../brand/tikhub.js', () => ({ fetchInstagramProfile: (...a: unknown[]) => fetchInstagramProfile(...a) }))
const downloadImageBase64 = vi.fn()
vi.mock('../../routes/productDescribe.js', () => ({ downloadImageBase64: (...a: unknown[]) => downloadImageBase64(...a) }))
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
const fetchMock = vi.fn()

const T = '11111111-1111-4111-8111-111111111111'
const facts = {
  url: 'https://mamaearth.example/', siteName: 'Mamaearth', title: null, description: 'Natural skincare.',
  headings: ['Goodness Inside'], ctas: ['Shop now'], bodyText: 'toxin-free', logoCandidates: ['https://cdn.example/logo.png'],
  iconUrls: ['https://mamaearth.example/apple.png'], themeColor: '#00A651', cssColors: ['#00A651'], fonts: ['Poppins'], stylesheetUrl: null,
}
const object = {
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women in Indian cities', region: 'IN',
  toneWords: ['warm', 'caring', 'honest'], emojiPolicy: 'minimal', signaturePhrases: ['Goodness Inside'], ctaExamples: ['Shop now'],
  voiceNotes: '## What we say', colors: { primary: '#00A651', secondary: '', accent: '', text: '', background: '', muted: '' }, headlineFont: 'Poppins',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('{"result":"applied"}', { status: 200 }))
  process.env.API_BASE_URL = 'https://api.test'
  process.env.INTERNAL_SERVICE_KEY = 'k'
  downloadImageBase64.mockResolvedValue('aGVsbG8=')
  generate.mockResolvedValue({ object, usage: { inputTokens: 100, outputTokens: 50 } })
})

async function run(inputData: Record<string, unknown>) {
  const { brandImportWorkflow } = await import('./brandImportWorkflow.js')
  const r = await brandImportWorkflow.createRun()
  return r.start({ inputData })
}

describe('brandImportWorkflow', () => {
  it('fills from website facts and reports the logo, favicon and source text', async () => {
    const result = await run({ tenantId: T, source: 'website', facts })
    expect(result.status).toBe('success')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/v1/internal/brand/import-result')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ tenantId: T, ok: true, logoUrl: 'https://cdn.example/logo.png', faviconUrl: 'https://mamaearth.example/apple.png' })
    expect(body.fields.name).toBe('Mamaearth')
    expect(body.sourceText).toContain('Goodness Inside')
  })

  it('sends the logo image to the fill agent with structured output', async () => {
    await run({ tenantId: T, source: 'website', facts })
    const [messages, options] = generate.mock.calls[0]
    expect(options.structuredOutput.schema).toBeDefined()
    expect(JSON.stringify(messages)).toContain('aGVsbG8=')
  })

  it('reads Instagram through TikHub and uses the profile picture as the logo', async () => {
    fetchInstagramProfile.mockResolvedValue({ handle: 'mamaearth.in', fullName: 'Mamaearth', bio: 'Goodness Inside', externalUrl: null, profilePicUrl: 'https://ig.example/pic.jpg', captions: ['Comment GLOW for the link'] })
    await run({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.logoUrl).toBe('https://ig.example/pic.jpg')
    expect(body.sourceText).toContain('Comment GLOW for the link')
  })

  it('fails the run when Instagram cannot be read', async () => {
    fetchInstagramProfile.mockResolvedValue(null)
    const result = await run({ tenantId: T, source: 'instagram', handle: 'nobody' })
    expect(result.status).toBe('failed')
  })
})
```

Run: `npx vitest run src/mastra/workflows/brandImportWorkflow.test.ts` → FAIL.

- [ ] **Step 6: Write the workflow**

```ts
// apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.ts
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { brandFillAgent, brandFillOutputSchema, buildFillPrompt } from '../agents/brandFillAgent.js'
import { fetchInstagramProfile } from '../brand/tikhub.js'
import { downloadImageBase64 } from '../../routes/productDescribe.js'
import { persistCost } from '../cost.js'
import type { InstagramFacts, WebsiteFacts } from '../brand/types.js'

const FILL_MODEL = process.env.MASTRA_LITE_MODEL ?? 'gemini-3.6-flash'

const inputSchema = z.object({
  tenantId: z.string().uuid(),
  source: z.enum(['website', 'instagram']),
  handle: z.string().optional(),
  facts: z.any().optional(), // WebsiteFacts, validated by the API that built it
})

const gatheredSchema = z.object({
  tenantId: z.string(),
  website: z.any().optional(),
  instagram: z.any().optional(),
  logoUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  sourceText: z.string(),
})

const filledSchema = gatheredSchema.extend({ fields: brandFillOutputSchema })

const gather = createStep({
  id: 'gather',
  inputSchema,
  outputSchema: gatheredSchema,
  execute: async ({ inputData }) => {
    if (inputData.source === 'instagram') {
      const ig: InstagramFacts | null = inputData.handle ? await fetchInstagramProfile(inputData.handle) : null
      if (!ig) throw new Error('instagram profile could not be read')
      return {
        tenantId: inputData.tenantId, instagram: ig, logoUrl: ig.profilePicUrl ?? undefined,
        sourceText: [ig.fullName, ig.bio, ...ig.captions].filter(Boolean).join('\n'),
      }
    }
    const w = inputData.facts as WebsiteFacts | undefined
    if (!w) throw new Error('website facts missing')
    return {
      tenantId: inputData.tenantId, website: w,
      logoUrl: w.logoCandidates[0] ?? w.iconUrls[0],
      faviconUrl: w.iconUrls[0],
      sourceText: [w.siteName, w.title, w.description, ...w.headings, ...w.ctas, w.bodyText].filter(Boolean).join('\n'),
    }
  },
})

const fill = createStep({
  id: 'fill',
  inputSchema: gatheredSchema,
  outputSchema: filledSchema,
  execute: async ({ inputData }) => {
    const prompt = buildFillPrompt({ website: inputData.website, instagram: inputData.instagram })
    const logo = inputData.logoUrl ? await downloadImageBase64(inputData.logoUrl) : null
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
    if (logo) content.unshift({ type: 'image', image: logo, mimeType: 'image/png' })
    const result = await brandFillAgent.generate(
      [{ role: 'user', content }] as never,
      { structuredOutput: { schema: brandFillOutputSchema } },
    )
    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (usage) {
      // Not charged to the tenant (spec) — logged so the cost stays visible.
      persistCost({ tenantId: inputData.tenantId, agentId: 'brand-fill', workflowId: 'creative-brand', model: FILL_MODEL, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 })
    }
    if (!result.object) throw new Error('fill returned no object')
    return { ...inputData, fields: result.object }
  },
})

export async function reportImportResult(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${process.env.API_BASE_URL ?? ''}/api/v1/internal/brand/import-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`import-result HTTP ${res.status}`)
}

const report = createStep({
  id: 'report',
  inputSchema: filledSchema,
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ inputData }) => {
    await reportImportResult({
      tenantId: inputData.tenantId, ok: true, fields: inputData.fields, sourceText: inputData.sourceText,
      logoUrl: inputData.logoUrl, faviconUrl: inputData.faviconUrl,
    })
    return { ok: true }
  },
})

export const brandImportWorkflow = createWorkflow({
  id: 'brand-import-workflow',
  inputSchema,
  outputSchema: z.object({ ok: z.boolean() }),
})
  .then(gather)
  .then(fill)
  .then(report)
  .commit()
```

`downloadImageBase64` returns base64 of a PNG/JPEG/WebP; if the fixture logo is JPEG the `mimeType` hint of `image/png` is still accepted by Gemini, but if Step 7 shows the gateway rejecting it, sniff the type with `sniffImageMimeType` from `src/media.ts` on the decoded bytes and pass that instead.

Run the workflow test: PASS (4 tests). If `result.status` for the failing case is not `'failed'` in Mastra 1.64, check `node_modules/@mastra/core/dist/docs/references/docs-workflows-error-handling.md` for the run result's status values and match the test to them.

- [ ] **Step 7: Write the internal route with its test**

```ts
// apps/agent-orchestrator/src/routes/brandImport.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const start = vi.fn()
vi.mock('../mastra/workflows/brandImportWorkflow.js', () => ({
  brandImportWorkflow: { createRun: async () => ({ runId: 'run-1', start: (...a: unknown[]) => start(...a) }) },
  reportImportResult: vi.fn(),
}))
const T = '11111111-1111-4111-8111-111111111111'

beforeEach(() => { vi.clearAllMocks(); process.env.INTERNAL_SERVICE_KEY = 'k'; start.mockResolvedValue({ status: 'success' }) })

async function call(body: unknown, key = 'k') {
  const { brandImportRouter } = await import('./brandImport.js')
  return brandImportRouter.request('/internal/brand/import', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Service-Key': key }, body: JSON.stringify(body) })
}

describe('POST /internal/brand/import', () => {
  it('refuses without the service key', async () => {
    expect((await call({ tenantId: T, source: 'instagram', handle: 'x' }, 'bad')).status).toBe(401)
  })

  it('starts the workflow and acks with 202 before it finishes', async () => {
    start.mockReturnValue(new Promise(() => {})) // never resolves
    const res = await call({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    expect(res.status).toBe(202)
    expect(start).toHaveBeenCalledWith({ inputData: { tenantId: T, source: 'instagram', handle: 'mamaearth.in' } })
  })

  it('rejects a body with no handle or facts', async () => {
    expect((await call({ tenantId: T, source: 'website' })).status).toBe(400)
  })
})
```

```ts
// apps/agent-orchestrator/src/routes/brandImport.ts
import { Hono } from 'hono'
import { z } from 'zod'
import { isInternalServiceKey } from '../service-key.js'
import { brandImportWorkflow, reportImportResult } from '../mastra/workflows/brandImportWorkflow.js'

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  source: z.enum(['website', 'instagram']),
  handle: z.string().regex(/^[a-z0-9._]{1,30}$/).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
}).refine((b) => (b.source === 'instagram' ? !!b.handle : !!b.facts), { message: 'handle or facts required' })

export const brandImportRouter = new Hono()

brandImportRouter.post('/internal/brand/import', async (c) => {
  if (!isInternalServiceKey(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const inputData = parsed.data
  const run = await brandImportWorkflow.createRun()
  // Ack now; the API polls the row. Any failure is reported so the page stops waiting.
  void Promise.resolve(run.start({ inputData }))
    .then((result: any) => {
      if (result?.status !== 'success') {
        console.error('[brandImport] run did not succeed', { tenantId: inputData.tenantId, runId: run.runId, status: result?.status, error: result?.error?.message })
        return reportImportResult({ tenantId: inputData.tenantId, ok: false, error: String(result?.error?.message ?? result?.status ?? 'failed').slice(0, 500) })
      }
    })
    .catch((err: Error) => {
      console.error('[brandImport] run threw', { tenantId: inputData.tenantId, error: err.message })
      return reportImportResult({ tenantId: inputData.tenantId, ok: false, error: err.message.slice(0, 500) }).catch(() => {})
    })
  return c.json({ runId: run.runId }, 202)
})
```

Mount it in `src/app.ts` next to `productDescribeRouter`:

```ts
import { brandImportRouter } from './routes/brandImport.js'
// ...
app.route('', brandImportRouter)
```

Register the workflow in `src/mastra/index.ts` (import and add to `workflows`):

```ts
import { brandImportWorkflow } from './workflows/brandImportWorkflow.js'
// ...
  workflows: {
    documentIngestion: ingestionWorkflow,
    'skill-draft': skillDraftWorkflow,
    brandImport: brandImportWorkflow,
  },
```

Run: `npx vitest run src/routes/brandImport.test.ts src/mastra/workflows/brandImportWorkflow.test.ts src/mastra/brand/tikhub.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check and commit**

Run: `npx tsc --noEmit` (in `apps/agent-orchestrator`). Expected: no errors.

```bash
git add apps/agent-orchestrator/src/mastra/brand apps/agent-orchestrator/src/mastra/agents/brandFillAgent.ts apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.ts apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.test.ts apps/agent-orchestrator/src/routes/brandImport.ts apps/agent-orchestrator/src/routes/brandImport.test.ts apps/agent-orchestrator/src/routes/productDescribe.ts apps/agent-orchestrator/src/mastra/index.ts apps/agent-orchestrator/src/app.ts apps/agent-orchestrator/.env.example
git commit -m "feat(orchestrator): brand import workflow — Instagram via TikHub, Mastra fill agent with structured output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Olmo sees the brand

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts` (add `fetchTenantBrand`)
- Modify: `apps/agent-orchestrator/src/mastra/context.ts` (add `brand`, `idToken` if missing — check first)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts` (load and set)
- Create: `apps/agent-orchestrator/src/mastra/agents/brandBlock.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (append block; one line in `WORKING_MEMORY_CONTRACT`)
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/brandBlock.test.ts`; one case added to `__tests__/platformAgent.test.ts`

**Interfaces:**
- Consumes: `TenantBrand` (Task 7 `types.ts`).
- Produces: `fetchTenantBrand(tenantId: string): Promise<TenantBrand | null>`; `requestContext.get('brand')` holding `TenantBrand | null`; `brandInstructionBlock(brand: TenantBrand | null): string`.

- [ ] **Step 1: Write the failing block test**

```ts
// apps/agent-orchestrator/src/mastra/agents/__tests__/brandBlock.test.ts
import { describe, it, expect } from 'vitest'
import { brandInstructionBlock } from '../brandBlock.js'
import type { TenantBrand } from '../../brand/types.js'

const brand: TenantBrand = {
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women 22-35 in Indian cities', region: 'IN',
  toneWords: ['warm', 'caring'], emojiPolicy: 'minimal', signaturePhrases: ['Goodness Inside'], bannedPhrases: ['cheap'],
  ctaExamples: ['Shop now'], voiceNotes: '## What we avoid\n- Discount-speak', colors: { primary: '#00A651' },
  headlineFont: 'Poppins', logoFileId: 'f1',
}

describe('brandInstructionBlock', () => {
  it('lists the saved brand and the rule that one-off changes are not saved', () => {
    const b = brandInstructionBlock(brand)
    expect(b).toContain('## Your brand')
    expect(b).toContain('Mamaearth')
    expect(b).toContain('Never use: "cheap"')
    expect(b).toContain('primary #00A651')
    expect(b).toContain('India')
    expect(b).toMatch(/one piece of work.*never changes the saved brand/i)
    expect(b).toContain('update_brand')
  })

  it('mentions the logo only when there is one', () => {
    expect(brandInstructionBlock(brand)).toContain('noLogo')
    expect(brandInstructionBlock({ ...brand, logoFileId: null })).not.toContain('noLogo')
  })

  it('without a brand, tells Olmo how to set one up', () => {
    const b = brandInstructionBlock(null)
    expect(b).toContain('no saved brand')
    expect(b).toContain('import_brand')
    expect(b).toContain('ask_clarifying_questions')
  })

  it('treats a row with no name as no brand', () => {
    expect(brandInstructionBlock({ ...brand, name: null })).toContain('no saved brand')
  })
})
```

Run: `npx vitest run src/mastra/agents/__tests__/brandBlock.test.ts` → FAIL.

- [ ] **Step 2: Write `brandBlock.ts`**

```ts
// apps/agent-orchestrator/src/mastra/agents/brandBlock.ts
import type { TenantBrand } from '../brand/types.js'

const REGION_NAMES: Record<string, string> = {
  IN: 'India', US: 'United States', UK: 'United Kingdom', AE: 'UAE', SG: 'Singapore', GLOBAL: 'Global',
}
const EMOJI_RULES: Record<string, string> = {
  none: 'none — never use emoji',
  minimal: 'minimal — at most one per caption',
  moderate: 'moderate — up to three per caption',
  expressive: 'expressive — emoji are part of the voice',
}
const quoted = (items: string[]) => items.map((i) => `"${i}"`).join(', ')

const SETUP = `\n\n## Your brand
This workspace has no saved brand yet. When the user asks to set up their brand, or pastes their website or Instagram handle for that purpose, call import_brand with the link or handle and tell them it will appear on the Brand page in a minute. If they have neither, ask with ask_clarifying_questions, one question at a time: what the brand is called, who it is for, and how it should sound; save each answer with update_brand, then ask them to send their logo if they have one and save it with update_brand's logoFileId.`

/** Olmo's view of the saved brand. Appended last so the stable instructions stay a cacheable prefix. */
export function brandInstructionBlock(brand: TenantBrand | null): string {
  if (!brand?.name?.trim()) return SETUP
  const colours = Object.entries(brand.colors ?? {}).map(([role, hex]) => `${role} ${hex}`).join(', ')
  const lines = [
    `- Name: ${brand.name}`,
    brand.oneLiner && `- What it makes: ${brand.oneLiner}`,
    brand.audience && `- Audience: ${brand.audience}`,
    `- Region: ${REGION_NAMES[brand.region] ?? brand.region} (use its currency, festivals and language habits)`,
    brand.toneWords.length > 0 && `- Tone: ${brand.toneWords.join(', ')}`,
    `- Emoji: ${EMOJI_RULES[brand.emojiPolicy] ?? brand.emojiPolicy}`,
    brand.signaturePhrases.length > 0 && `- Phrases it owns: ${quoted(brand.signaturePhrases)}`,
    brand.bannedPhrases.length > 0 && `- Never use: ${quoted(brand.bannedPhrases)}`,
    brand.ctaExamples.length > 0 && `- Calls to action it uses: ${quoted(brand.ctaExamples)}`,
    colours && `- Colours: ${colours}`,
    brand.headlineFont && `- Headline font: ${brand.headlineFont}`,
    brand.logoFileId && `- Logo: saved. composite_end_card puts it on the end card automatically; pass noLogo: true only when the user asks for no logo on that ad.`,
  ].filter(Boolean)
  const notes = brand.voiceNotes?.trim() ? `\nVoice notes:\n${brand.voiceNotes.trim()}` : ''
  return `\n\n## Your brand
This is the workspace's saved brand. Follow it in every caption, script, image and video. If the user asks for something different for one piece of work ("no logo on this one", "use blue here"), do it for that piece only; that never changes the saved brand.
${lines.join('\n')}${notes}
When the user states a lasting brand fact (its name, audience, tone, phrases to use or avoid, colours, logo), save it with update_brand. When they paste a website or Instagram handle to refresh the brand, call import_brand.`
}
```

Run the test: PASS.

- [ ] **Step 3: Add `fetchTenantBrand`**

In `src/usage.ts`, after `fetchAgentName`:

```ts
// Not cached: the user edits the brand on the Brand page and expects the next
// turn to follow it. One indexed lookup (creative_brand_tenant_unique) per turn.
export async function fetchTenantBrand(tenantId: string): Promise<TenantBrand | null> {
  if (!tenantId) return null
  const res = await getPool().query<{
    name: string | null; one_liner: string | null; audience: string | null; region: string
    tone_words: string[]; emoji_policy: string; signature_phrases: string[]; banned_phrases: string[]
    cta_examples: string[]; voice_notes: string | null; colors: Record<string, string> | null
    headline_font: string | null; logo_file_id: string | null
  }>(
    `SELECT name, one_liner, audience, region, tone_words, emoji_policy, signature_phrases, banned_phrases,
            cta_examples, voice_notes, colors, headline_font, logo_file_id
       FROM creative_brand WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  )
  const r = res.rows[0]
  if (!r) return null
  return {
    name: r.name, oneLiner: r.one_liner, audience: r.audience, region: r.region,
    toneWords: r.tone_words ?? [], emojiPolicy: r.emoji_policy, signaturePhrases: r.signature_phrases ?? [],
    bannedPhrases: r.banned_phrases ?? [], ctaExamples: r.cta_examples ?? [], voiceNotes: r.voice_notes,
    colors: r.colors ?? {}, headlineFont: r.headline_font, logoFileId: r.logo_file_id,
  }
}
```

Add `import type { TenantBrand } from './mastra/brand/types.js'` at the top of `usage.ts`.

- [ ] **Step 4: Put it on the request context**

In `src/mastra/context.ts`, inside `tenantContextSchema`, add:

```ts
  // Set by chatStream.ts from fetchTenantBrand(): the workspace's saved ad brand,
  // or null. Read by platformAgent's instructions resolver (## Your brand) and
  // by composite_end_card for the default logo.
  brand: z.custom<TenantBrand | null>().optional(),
```

with `import type { TenantBrand } from './brand/types.js'`.

In `src/routes/chatStream.ts`, add `fetchTenantBrand(tenantId)` as the last element of the existing `Promise.all([...])` that fetches `skillSettings, agentPersonaPrompt, …` and name it `tenantBrand` in the destructuring. A failure must not break the turn, so wrap it:

```ts
      fetchTenantBrand(tenantId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchTenantBrand failed, continuing without brand:`, (err as Error).message)
        return null
      }),
```

After `requestContext.set('allowedSubAgents', allowedSubAgents)`:

```ts
    requestContext.set('brand', tenantBrand)
```

Import `fetchTenantBrand` from `../usage.js` alongside the other `fetch*` helpers already imported there.

- [ ] **Step 5: Append the block and the memory line**

In `src/mastra/agents/platformAgent.ts`:

1. Import: `import { brandInstructionBlock } from './brandBlock.js'` and `import type { TenantBrand } from '../brand/types.js'`.
2. Change the resolver's single return (currently `return composed + CLARIFICATION_CONTRACT + … + WORKING_MEMORY_CONTRACT`) to append the block last:

```ts
    const brand = (requestContext?.get('brand') as TenantBrand | null | undefined) ?? null
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT + PAST_TASKS_CONTRACT + WORKING_MEMORY_CONTRACT + brandInstructionBlock(brand)
```

3. In `WORKING_MEMORY_CONTRACT`, add one bullet after the `- Brand Context holds facts…` bullet (do not change the existing bullet):

```
- The brand's name, audience, tone, phrases to use or avoid, colours and logo live in the saved brand (see "Your brand"); save them with update_brand, not in working memory. Brand Context keeps only what the saved brand has no place for: a default ratio or duration, and standing exclusions.
```

- [ ] **Step 6: Add a platformAgent test**

In `src/mastra/agents/__tests__/platformAgent.test.ts`, add:

```ts
  it('appends the saved brand last when the request carries one', async () => {
    const requestContext = new RequestContext()
    requestContext.set('brand', { name: 'Mamaearth', oneLiner: null, audience: null, region: 'IN', toneWords: ['warm'], emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null, colors: {}, headlineFont: null, logoFileId: null })
    const instructions = await platformAgent.getInstructions({ requestContext }) as string
    expect(instructions.trimEnd()).toMatch(/## Your brand[\s\S]*Mamaearth[\s\S]*import_brand\.$/)
    expect(instructions).toContain('save them with update_brand, not in working memory')
  })
```

Match the surrounding test file's `describe` and any `beforeAll` setup the other `getInstructions` cases use.

- [ ] **Step 7: Run tests and type-check**

Run: `npx vitest run src/mastra/agents/__tests__/brandBlock.test.ts src/mastra/agents/__tests__/platformAgent.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/mastra/context.ts apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/mastra/agents/brandBlock.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/brandBlock.test.ts apps/agent-orchestrator/src/mastra/agents/__tests__/platformAgent.test.ts
git commit -m "feat(orchestrator): Olmo follows the saved brand — loaded per turn, appended to instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `update_brand`, `import_brand` and the end-card logo default

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/brandTools.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (`SERVER_TOOLS`)
- Modify: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/brandTools.test.ts`; cases added to `src/mastra/tools/compositeEndCard.test.ts`

**Interfaces:**
- Consumes: `/api/v1/brand` (PATCH) and `/api/v1/brand/import` (POST) from Task 5; `requestContext.get('brand')` and `requestContext.get('idToken')`.
- Produces: tools `update_brand` and `import_brand` registered on Olmo; `composite_end_card` input `noLogo?: boolean`; exported `resolveEndCardLogo(input: { logoFileId?: string; noLogo?: boolean }, brand: TenantBrand | null | undefined): string | undefined`.

- [ ] **Step 1: Write the failing tool tests**

```ts
// apps/agent-orchestrator/src/mastra/tools/brandTools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock)
  process.env.API_BASE_URL = 'https://api.test'
})
const ctx = (idToken: string | undefined = 'tok') => {
  const rc = new RequestContext()
  if (idToken) rc.set('idToken', idToken)
  return { requestContext: rc } as never
}

describe('update_brand', () => {
  it('PATCHes only the given fields with the user token', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const out = await updateBrandTool.execute!({ bannedPhrases: ['cheap'] } as never, ctx())
    expect(out).toMatchObject({ success: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/v1/brand')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ bannedPhrases: ['cheap'] })
  })

  it('reports a plain failure without internals', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"x"}', { status: 500 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const out = await updateBrandTool.execute!({ name: 'X' } as never, ctx()) as { success: boolean; error: string }
    expect(out.success).toBe(false)
    expect(out.error).not.toMatch(/500|server|status/i)
  })

  it('refuses outside a live chat', async () => {
    const { updateBrandTool } = await import('./brandTools.js')
    expect(await updateBrandTool.execute!({ name: 'X' } as never, ctx(undefined))).toMatchObject({ success: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('import_brand', () => {
  it('POSTs the value and says the brand is being read', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{"importStatus":"importing"}}', { status: 202 }))
    const { importBrandTool } = await import('./brandTools.js')
    const out = await importBrandTool.execute!({ value: '@mamaearth.in' } as never, ctx())
    expect(out).toMatchObject({ success: true, status: 'importing' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ value: '@mamaearth.in' })
  })

  it('passes on the "not a site or handle" message', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Paste a website link or an Instagram handle"}', { status: 400 }))
    const { importBrandTool } = await import('./brandTools.js')
    expect(await importBrandTool.execute!({ value: 'hi' } as never, ctx())).toMatchObject({ success: false, error: 'Paste a website link or an Instagram handle' })
  })
})
```

Run: `npx vitest run src/mastra/tools/brandTools.test.ts` → FAIL.

- [ ] **Step 2: Write `brandTools.ts`**

```ts
// apps/agent-orchestrator/src/mastra/tools/brandTools.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { API_BASE_URL } from '../../types.js'

const COLOR = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const updateBrandTool = createTool({
  id: 'update_brand',
  description: "Save lasting facts about the workspace's brand that the user stated: its name, one-line description, audience, region, tone words, emoji policy, phrases it owns, phrases it never uses, calls to action, voice notes, colours, headline font or logo. Send only the fields that changed. Never use it for a choice that applies to one ad only.",
  inputSchema: z.object({
    name: z.string().max(80).optional(),
    oneLiner: z.string().max(200).optional(),
    audience: z.string().max(300).optional(),
    region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']).optional(),
    toneWords: z.array(z.string().max(30)).max(5).optional(),
    emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']).optional(),
    signaturePhrases: z.array(z.string().max(80)).max(10).optional(),
    bannedPhrases: z.array(z.string().max(80)).max(30).optional(),
    ctaExamples: z.array(z.string().max(80)).max(10).optional(),
    voiceNotes: z.string().max(3000).optional(),
    colors: z.object({
      primary: COLOR.optional(), secondary: COLOR.optional(), accent: COLOR.optional(),
      text: COLOR.optional(), background: COLOR.optional(), muted: COLOR.optional(),
    }).optional(),
    headlineFont: z.string().max(60).optional(),
    logoFileId: z.string().uuid().optional().describe('fileId of a logo image the user sent in this chat'),
  }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!idToken) return { success: false, error: 'The brand can only be changed from a live chat.' }
    const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
    if (Object.keys(fields).length === 0) return { success: false, error: 'Nothing to save.' }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/brand`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) {
        console.error('[update_brand] API', res.status, await res.text().catch(() => ''))
        return { success: false, error: "The brand couldn't be saved. Try again." }
      }
      return { success: true, saved: Object.keys(fields) }
    } catch (err) {
      console.error('[update_brand] failed', (err as Error).message)
      return { success: false, error: "The brand couldn't be saved. Try again." }
    }
  },
})

export const importBrandTool = createTool({
  id: 'import_brand',
  description: "Fill the workspace's brand from its website or Instagram handle. Use when the user shares their own site or handle to set up or refresh the brand. Fields the user already edited are kept.",
  inputSchema: z.object({ value: z.string().min(1).max(500).describe('The website link or Instagram handle exactly as the user gave it') }),
  execute: async ({ value }, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!idToken) return { success: false, error: 'The brand can only be set up from a live chat.' }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/brand/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
      const body = await res.json().catch(() => ({})) as { message?: string; data?: { importStatus?: string } }
      if (res.status === 400) return { success: false, error: body.message ?? 'Paste a website link or an Instagram handle' }
      if (!res.ok) {
        console.error('[import_brand] API', res.status)
        return { success: false, error: "Couldn't start reading that. Ask the user about their brand instead." }
      }
      const status = body.data?.importStatus ?? 'importing'
      return status === 'failed'
        ? { success: false, error: "Couldn't read that. Ask the user about their brand instead." }
        : { success: true, status, note: 'The brand will appear on the Brand page in about a minute.' }
    } catch (err) {
      console.error('[import_brand] failed', (err as Error).message)
      return { success: false, error: "Couldn't start reading that. Ask the user about their brand instead." }
    }
  },
})
```

Run the test: PASS.

- [ ] **Step 3: Register the tools**

In `platformAgent.ts`, import `{ updateBrandTool, importBrandTool } from '../tools/brandTools.js'` and add to `SERVER_TOOLS`:

```ts
  update_brand: updateBrandTool,
  import_brand: importBrandTool,
```

Check `src/toolVisibility.ts` and any tool allow-list used by `tools:` resolvers (`git grep -n "save_skill" apps/agent-orchestrator/src` shows where an Olmo-only tool is listed). If `save_skill` appears in an allow-list or visibility map, add both brand tools beside it the same way.

- [ ] **Step 4: Write the failing end-card cases**

Add to `src/mastra/tools/compositeEndCard.test.ts`:

```ts
import { resolveEndCardLogo } from './compositeEndCard.js'

describe('resolveEndCardLogo', () => {
  const brand = { logoFileId: 'brand-logo' } as never
  it('uses the brand logo when none is given', () => {
    expect(resolveEndCardLogo({}, brand)).toBe('brand-logo')
  })
  it('an explicit logo wins over the brand logo', () => {
    expect(resolveEndCardLogo({ logoFileId: 'given' }, brand)).toBe('given')
  })
  it('noLogo turns it off for this ad', () => {
    expect(resolveEndCardLogo({ noLogo: true }, brand)).toBeUndefined()
  })
  it('no brand and no logo means no logo', () => {
    expect(resolveEndCardLogo({}, null)).toBeUndefined()
    expect(resolveEndCardLogo({}, { logoFileId: null } as never)).toBeUndefined()
  })
})
```

Run: FAIL (`resolveEndCardLogo` not exported).

- [ ] **Step 5: Implement the default**

In `compositeEndCard.ts`:

1. Add the helper near the top-level exports:

```ts
/** The logo for this end card: the one passed in, else the saved brand's, unless the user said no logo for this ad. */
export function resolveEndCardLogo(input: { logoFileId?: string; noLogo?: boolean }, brand: TenantBrand | null | undefined): string | undefined {
  if (input.noLogo) return undefined
  return input.logoFileId ?? brand?.logoFileId ?? undefined
}
```

with `import type { TenantBrand } from '../brand/types.js'`.

2. In the input schema, next to `logoFileId`, add:

```ts
  noLogo: z.boolean().optional().describe('True only when the user asked for no logo on this ad. Otherwise the saved brand logo is used when logoFileId is not given'),
```

3. In `execute`, replace the destructured `logoFileId` with a resolved one. Change

```ts
    const { videoFileId, productPhotoFileId, aspectRatio, holdSeconds = 0, avoidFaces, logoFileId, vegMark, disclaimerLines } = inputData as z.infer<typeof inputSchema>
```

to

```ts
    const { videoFileId, productPhotoFileId, aspectRatio, holdSeconds = 0, avoidFaces, vegMark, disclaimerLines } = inputData as z.infer<typeof inputSchema>
    const logoFileId = resolveEndCardLogo(inputData as z.infer<typeof inputSchema>, execContext?.requestContext?.get('brand') as TenantBrand | null | undefined)
```

Use the execute's actual second-parameter name if it is not `execContext`. Every later use of `logoFileId` in `execute` stays as is. Leave the tool description's existing sentences unchanged and append: `" When logoFileId is not given, the saved brand logo is used; pass noLogo: true when the user asks for no logo."`

- [ ] **Step 6: Run the tool tests and the full orchestrator suite**

Run: `npx vitest run src/mastra/tools/brandTools.test.ts src/mastra/tools/compositeEndCard.test.ts && npx vitest run && npx tsc --noEmit`
Expected: all pass (the baseline had 0 orchestrator failures), no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/brandTools.ts apps/agent-orchestrator/src/mastra/tools/brandTools.test.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(orchestrator): update_brand and import_brand tools; end card uses the brand logo by default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Brand page, sidebar, chat prefill

**Files:**
- Create: `apps/web/components/platform/brand/brandApi.ts`
- Create: `apps/web/components/platform/brand/BrandEmptyState.tsx`
- Create: `apps/web/components/platform/brand/BrandForm.tsx`
- Create: `apps/web/app/[tenant]/dashboard/brand/page.tsx`
- Modify: `apps/web/lib/sidebar-items.ts`
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`
- Test: `apps/web/components/platform/brand/BrandEmptyState.test.tsx`, `BrandForm.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/brand`, `PATCH /api/v1/brand`, `POST /api/v1/brand/import` (Task 5), `storeCreativeImage(file, prefix)`.
- Produces: page at `/{tenant}/dashboard/brand`; chat page honours `?prefill=<text>`.

Before writing UI, read `apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx` for how this repo's web tests render with React Query and mock `@/lib/api`, and copy that setup.

- [ ] **Step 1: Write `brandApi.ts`**

```ts
// apps/web/components/platform/brand/brandApi.ts
import { api } from '@/lib/api';

export const BRAND_REGIONS = [
    { value: 'IN', label: 'India' }, { value: 'US', label: 'US' }, { value: 'UK', label: 'UK' },
    { value: 'AE', label: 'UAE' }, { value: 'SG', label: 'Singapore' }, { value: 'GLOBAL', label: 'Global' },
] as const;
export const EMOJI_POLICIES = [
    { value: 'none', label: 'None' }, { value: 'minimal', label: 'Minimal' },
    { value: 'moderate', label: 'Moderate' }, { value: 'expressive', label: 'Expressive' },
] as const;
export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'text', 'background', 'muted'] as const;
export const FONT_CHOICES = ['Inter', 'Poppins', 'Space Grotesk', 'Figtree', 'Playfair Display', 'JetBrains Mono'] as const;

export interface BrandImageRef { fileId: string; url: string | null }
export interface BrandRecord {
    name: string | null; oneLiner: string | null; audience: string | null;
    region: string; toneWords: string[]; emojiPolicy: string;
    signaturePhrases: string[]; bannedPhrases: string[]; ctaExamples: string[]; voiceNotes: string | null;
    colors: Partial<Record<typeof COLOR_ROLES[number], string>>; headlineFont: string | null;
    logo: BrandImageRef | null; favicon: BrandImageRef | null; mascot: BrandImageRef | null;
    sourceType: 'website' | 'instagram' | 'chat' | null; sourceValue: string | null;
    importStatus: 'idle' | 'importing' | 'done' | 'failed'; importedAt: string | null;
    ready: boolean; missing: Array<'name' | 'audience' | 'voice'>; updatedAt: string;
}
export type BrandPatch = Partial<{
    name: string | null; oneLiner: string | null; audience: string | null; region: string;
    toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[];
    ctaExamples: string[]; voiceNotes: string | null; colors: BrandRecord['colors']; headlineFont: string | null;
    logoFileId: string | null; faviconFileId: string | null; mascotFileId: string | null;
}>;

export const BRAND_QUERY_KEY = ['brand'] as const;
export const BRAND_IMAGE_PREFIX = 'brand/';

export async function getBrand(): Promise<BrandRecord | null> {
    return (await api.get<{ data: BrandRecord | null }>('/api/v1/brand')).data;
}
export async function patchBrand(patch: BrandPatch): Promise<BrandRecord> {
    return (await api.patch<{ data: BrandRecord }>('/api/v1/brand', patch)).data;
}
export async function importBrand(value: string): Promise<BrandRecord> {
    return (await api.post<{ data: BrandRecord }>('/api/v1/brand/import', { value })).data;
}

/** "Filled from mamaearth.in · 2 days ago" */
export function sourceLine(brand: BrandRecord, now = new Date()): string | null {
    if (!brand.sourceValue || brand.sourceType === 'chat') return null;
    const shown = brand.sourceType === 'website' ? brand.sourceValue.replace(/^https:\/\//, '').replace(/\/$/, '') : brand.sourceValue;
    if (!brand.importedAt) return `Filled from ${shown}`;
    const days = Math.floor((now.getTime() - new Date(brand.importedAt).getTime()) / 86_400_000);
    const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    return `Filled from ${shown} · ${when}`;
}
```

- [ ] **Step 2: Write the failing empty-state test**

```tsx
// apps/web/components/platform/brand/BrandEmptyState.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandEmptyState } from './BrandEmptyState';

describe('BrandEmptyState', () => {
    it('submits what the user pasted', () => {
        const onSubmit = vi.fn();
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={onSubmit} busy={false} failed={false} />);
        fireEvent.change(screen.getByPlaceholderText(/yourbrand\.com/i), { target: { value: '@mamaearth.in' } });
        fireEvent.click(screen.getByRole('button', { name: /fill in/i }));
        expect(onSubmit).toHaveBeenCalledWith('@mamaearth.in');
    });

    it('links to chat for brands with no website', () => {
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect(screen.getByRole('link', { name: /tell olmo about your brand/i })).toHaveAttribute('href', '/t/dashboard/chat?prefill=Set%20up%20my%20brand');
    });

    it('shows the plain failure line after a failed read', () => {
        render(<BrandEmptyState chatHref="/x" onSubmit={vi.fn()} busy={false} failed />);
        expect(screen.getByText("Couldn't read that. Tell Olmo about your brand instead.")).toBeInTheDocument();
    });
});
```

Run: `cd apps/web && npx vitest run components/platform/brand` → FAIL.

- [ ] **Step 3: Write `BrandEmptyState.tsx`**

```tsx
// apps/web/components/platform/brand/BrandEmptyState.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const FAILED_COPY = "Couldn't read that. Tell Olmo about your brand instead.";

export function BrandEmptyState({ chatHref, onSubmit, busy, failed }: {
    chatHref: string; onSubmit: (value: string) => void; busy: boolean; failed: boolean;
}) {
    const [value, setValue] = useState('');
    const submit = () => { if (value.trim() && !busy) onSubmit(value.trim()); };
    return (
        <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
            <p className="text-base font-medium text-foreground">Paste your website or Instagram handle</p>
            <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="yourbrand.com  or  @yourbrand" aria-label="Website or Instagram handle" />
                <Button type="submit" disabled={busy || !value.trim()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fill in'}
                </Button>
            </form>
            {failed && <p className="text-sm text-destructive">{FAILED_COPY}</p>}
            <Link href={chatHref} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                No website? Tell Olmo about your brand →
            </Link>
        </div>
    );
}
```

Run the test: PASS.

- [ ] **Step 4: Write the failing form test**

```tsx
// apps/web/components/platform/brand/BrandForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandForm } from './BrandForm';
import type { BrandRecord } from './brandApi';

const brand: BrandRecord = {
    name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: null, region: 'IN', toneWords: ['warm'],
    emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: ['Shop now'], voiceNotes: null,
    colors: { primary: '#00A651' }, headlineFont: 'Poppins', logo: null, favicon: null, mascot: null,
    sourceType: 'website', sourceValue: 'https://mamaearth.in/', importStatus: 'done', importedAt: new Date().toISOString(),
    ready: false, missing: ['audience'], updatedAt: new Date().toISOString(),
};

describe('BrandForm', () => {
    it('shows readiness ticks and what is missing', () => {
        render(<BrandForm brand={brand} onSave={vi.fn()} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect(screen.getByText(/Olmo needs three things to write like Mamaearth/)).toBeInTheDocument();
        expect(screen.getByTestId('ready-audience')).toHaveAttribute('data-done', 'false');
        expect(screen.getByTestId('ready-name')).toHaveAttribute('data-done', 'true');
    });

    it('saves a text field on blur, only when it changed', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const audience = screen.getByLabelText('Audience');
        fireEvent.blur(audience);
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.change(audience, { target: { value: 'Women in Indian cities' } });
        fireEvent.blur(audience);
        expect(onSave).toHaveBeenCalledWith({ audience: 'Women in Indian cities' });
    });

    it('saves a list field one item per line', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const banned = screen.getByLabelText('Banned phrases');
        fireEvent.change(banned, { target: { value: 'cheap\n\n literally ' } });
        fireEvent.blur(banned);
        expect(onSave).toHaveBeenCalledWith({ bannedPhrases: ['cheap', 'literally'] });
    });

    it('saves a region chip immediately', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'UAE' }));
        expect(onSave).toHaveBeenCalledWith({ region: 'AE' });
    });

    it('shows where the brand came from', () => {
        render(<BrandForm brand={brand} onSave={vi.fn()} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect(screen.getByText(/Filled from mamaearth\.in · today/)).toBeInTheDocument();
    });
});
```

Run: FAIL.

- [ ] **Step 5: Write `BrandForm.tsx`**

```tsx
// apps/web/components/platform/brand/BrandForm.tsx
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Circle, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
    BRAND_REGIONS, COLOR_ROLES, EMOJI_POLICIES, FONT_CHOICES, sourceLine,
    type BrandPatch, type BrandRecord,
} from './brandApi';

type ImageSlot = 'logo' | 'favicon' | 'mascot';
interface Props {
    brand: BrandRecord;
    onSave: (patch: BrandPatch) => void;
    onRefresh: () => void;
    onUploadImage: (slot: ImageSlot, file: File | null) => void;
    refreshing: boolean;
}

const toLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

// A row: label + hint on the left, control on the right, hairline divider below. No boxes.
function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
    return (
        <div className="grid gap-2 border-b border-border/60 py-4 last:border-b-0 sm:grid-cols-[200px_1fr] sm:gap-6">
            <div>
                <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
                {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
            </div>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

function Section({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="pt-8">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-2">
                <div>
                    <h2 className="text-base font-semibold text-foreground">{title}</h2>
                    <p className="text-xs text-muted-foreground">{subtitle}</p>
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

/** Text input that saves on blur, only when the value changed. */
function TextField({ id, label, hint, value, multiline, placeholder, onSave }: {
    id: string; label: string; hint?: string; value: string; multiline?: boolean; placeholder?: string; onSave: (v: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const blur = () => { if (draft.trim() !== value.trim()) onSave(draft.trim()); };
    const common = { id, value: draft, placeholder, onBlur: blur, 'aria-label': label };
    return (
        <Row label={label} hint={hint} htmlFor={id}>
            {multiline
                ? <Textarea {...common} rows={4} onChange={(e) => setDraft(e.target.value)} />
                : <Input {...common} onChange={(e) => setDraft(e.target.value)} />}
        </Row>
    );
}

function Chips<T extends string>({ options, value, onPick }: { options: ReadonlyArray<{ value: T; label: string }>; value: string; onPick: (v: T) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {options.map((o) => (
                <button key={o.value} type="button" onClick={() => o.value !== value && onPick(o.value)}
                    className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                        o.value === value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function ToneWords({ words, onSave }: { words: string[]; onSave: (w: string[]) => void }) {
    const [draft, setDraft] = useState('');
    const add = () => {
        const w = draft.trim();
        if (w && !words.includes(w) && words.length < 5) onSave([...words, w]);
        setDraft('');
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            {words.map((w) => (
                <span key={w} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground">
                    {w}
                    <button type="button" aria-label={`Remove ${w}`} onClick={() => onSave(words.filter((x) => x !== w))}><X className="h-3 w-3" /></button>
                </span>
            ))}
            {words.length < 5 && (
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    placeholder="+ add" aria-label="Add tone word" className="h-7 w-28 text-xs" />
            )}
        </div>
    );
}

function ImageField({ slot, label, image, onUpload }: { slot: ImageSlot; label: string; image: BrandRecord['logo']; onUpload: Props['onUploadImage'] }) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <Row label={label}>
            <div className="flex items-center gap-3 text-sm">
                {image?.url
                    ? <img src={image.url} alt={label} className="h-10 w-10 rounded object-contain" />
                    : <span className="text-muted-foreground">Not set</span>}
                <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(slot, f); e.target.value = ''; }} />
                <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => input.current?.click()}>
                    <ImagePlus className="h-3.5 w-3.5" />{image ? 'Replace' : 'Upload'}
                </button>
                {image && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onUpload(slot, null)}>Remove</button>}
            </div>
        </Row>
    );
}

function ColorSwatch({ role, value, onSave }: { role: string; value: string | undefined; onSave: (hex: string) => void }) {
    return (
        <label className="flex items-center gap-2 text-xs">
            <input type="color" aria-label={`${role} colour`} value={value ?? '#FFFFFF'}
                onChange={(e) => onSave(e.target.value.toUpperCase())}
                className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent p-0" />
            <span className="capitalize text-foreground">{role}</span>
            <span className="text-muted-foreground">{value ?? 'Not set'}</span>
        </label>
    );
}

export function BrandForm({ brand, onSave, onRefresh, onUploadImage, refreshing }: Props) {
    const name = brand.name?.trim() || 'your brand';
    const ready = [
        { key: 'name', label: 'Name' }, { key: 'audience', label: 'Audience' }, { key: 'voice', label: 'Voice' },
    ] as const;
    const source = sourceLine(brand);
    return (
        <div className="pb-16">
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>Olmo needs three things to write like {name}:</span>
                {ready.map((r) => {
                    const done = !brand.missing.includes(r.key);
                    return (
                        <span key={r.key} data-testid={`ready-${r.key}`} data-done={String(done)}
                            className={cn('inline-flex items-center gap-1', done ? 'text-primary' : 'text-muted-foreground')}>
                            {done ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}{r.label}
                        </span>
                    );
                })}
            </div>

            <Section title="Basics" subtitle="What your brand is at a glance.">
                <TextField id="brand-name" label="Brand name" hint="The name your audience knows you by." value={brand.name ?? ''} onSave={(v) => onSave({ name: v || null })} />
                <TextField id="brand-one-liner" label="One-liner" hint="What you make, in one plain sentence." value={brand.oneLiner ?? ''} onSave={(v) => onSave({ oneLiner: v || null })} />
                <TextField id="brand-audience" label="Audience" hint="Who it's for, in plain words." value={brand.audience ?? ''} multiline onSave={(v) => onSave({ audience: v || null })} />
                <Row label="Region" hint="Local currency, festivals and language.">
                    <Chips options={BRAND_REGIONS} value={brand.region} onPick={(region) => onSave({ region })} />
                </Row>
            </Section>

            <Section title="Voice" subtitle="How you sound. Every caption and script follows it.">
                <Row label="Tone words" hint="3 to 5 words for how you sound.">
                    <ToneWords words={brand.toneWords} onSave={(toneWords) => onSave({ toneWords })} />
                </Row>
                <Row label="Emoji">
                    <Chips options={EMOJI_POLICIES} value={brand.emojiPolicy} onPick={(emojiPolicy) => onSave({ emojiPolicy })} />
                </Row>
                <TextField id="brand-signature" label="Signature phrases" hint="One per line. Phrases you own." multiline
                    value={brand.signaturePhrases.join('\n')} onSave={(v) => onSave({ signaturePhrases: toLines(v) })} />
                <TextField id="brand-banned" label="Banned phrases" hint="One per line. Words your brand never uses." multiline
                    placeholder={'GAME-CHANGER\nliterally'} value={brand.bannedPhrases.join('\n')} onSave={(v) => onSave({ bannedPhrases: toLines(v) })} />
                <TextField id="brand-ctas" label="CTAs" hint="One per line. How you ask people to act." multiline
                    value={brand.ctaExamples.join('\n')} onSave={(v) => onSave({ ctaExamples: toLines(v) })} />
                <TextField id="brand-notes" label="Voice notes" hint="Anything else. Markdown works." multiline
                    value={brand.voiceNotes ?? ''} onSave={(v) => onSave({ voiceNotes: v || null })} />
            </Section>

            <Section title="Visual identity" subtitle="The colours, type and marks Olmo puts in every image."
                action={brand.sourceValue && brand.sourceType !== 'chat' ? (
                    <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
                        {refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
                    </Button>
                ) : undefined}>
                <ImageField slot="logo" label="Logo" image={brand.logo} onUpload={onUploadImage} />
                <ImageField slot="favicon" label="Favicon" image={brand.favicon} onUpload={onUploadImage} />
                <ImageField slot="mascot" label="Mascot" image={brand.mascot} onUpload={onUploadImage} />
                <Row label="Colours">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {COLOR_ROLES.map((role) => (
                            <ColorSwatch key={role} role={role} value={brand.colors[role]}
                                onSave={(hex) => onSave({ colors: { ...brand.colors, [role]: hex } })} />
                        ))}
                    </div>
                </Row>
                <Row label="Font" htmlFor="brand-font">
                    <Input id="brand-font" list="brand-fonts" defaultValue={brand.headlineFont ?? ''} aria-label="Font"
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (brand.headlineFont ?? '')) onSave({ headlineFont: v || null }); }} />
                    <datalist id="brand-fonts">{FONT_CHOICES.map((f) => <option key={f} value={f} />)}</datalist>
                </Row>
            </Section>

            {source && <p className="pt-6 text-xs text-muted-foreground">{source}</p>}
        </div>
    );
}
```

Check `@/components/ui/textarea` exists (`ls apps/web/components/ui/textarea.tsx`); if not, use a plain `<textarea>` with the `Input` class names.

Run: `npx vitest run components/platform/brand` → PASS.

- [ ] **Step 6: Write the page**

```tsx
// apps/web/app/[tenant]/dashboard/brand/page.tsx
'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PermissionGate } from '@/components/platform/PermissionGate';
import { BrandEmptyState, FAILED_COPY } from '@/components/platform/brand/BrandEmptyState';
import { BrandForm } from '@/components/platform/brand/BrandForm';
import {
    BRAND_IMAGE_PREFIX, BRAND_QUERY_KEY, getBrand, importBrand, patchBrand, type BrandPatch, type BrandRecord,
} from '@/components/platform/brand/brandApi';
import { storeCreativeImage } from '@/components/platform/chat/creative-library/storeCreativeImage';

const POLL_MS = 2000;

function Shimmer() {
    return (
        <div className="space-y-8 pt-6" aria-busy="true">
            {['Basics', 'Voice', 'Visual identity'].map((title) => (
                <section key={title}>
                    <h2 className="border-b border-border pb-2 text-base font-semibold text-foreground">{title}</h2>
                    {[0, 1, 2].map((i) => <div key={i} className="my-4 h-4 w-2/3 animate-pulse rounded bg-muted" />)}
                </section>
            ))}
        </div>
    );
}

export default function BrandPage() {
    const { tenant } = useParams<{ tenant: string }>();
    const queryClient = useQueryClient();
    const { data: brand, isLoading } = useQuery({
        queryKey: BRAND_QUERY_KEY,
        queryFn: getBrand,
        refetchInterval: (q) => ((q.state.data as BrandRecord | null | undefined)?.importStatus === 'importing' ? POLL_MS : false),
    });
    const setBrand = (b: BrandRecord) => queryClient.setQueryData(BRAND_QUERY_KEY, b);

    const save = useMutation({
        mutationFn: (patch: BrandPatch) => patchBrand(patch),
        onSuccess: setBrand,
        onError: () => toast.error("Couldn't save that. Try again."),
    });
    const startImport = useMutation({
        mutationFn: (value: string) => importBrand(value),
        onSuccess: setBrand,
        onError: () => toast.error(FAILED_COPY),
    });

    const uploadImage = async (slot: 'logo' | 'favicon' | 'mascot', file: File | null) => {
        const key = `${slot}FileId` as const;
        if (!file) return save.mutate({ [key]: null });
        try {
            const stored = await storeCreativeImage(file, BRAND_IMAGE_PREFIX);
            save.mutate({ [key]: stored.fileId });
        } catch {
            toast.error("Couldn't add that image. Try again.");
        }
    };

    const chatHref = `/${tenant}/dashboard/chat?prefill=${encodeURIComponent('Set up my brand')}`;
    const importing = brand?.importStatus === 'importing';
    const hasContent = !!brand && (!!brand.name || brand.toneWords.length > 0 || !!brand.logo);

    return (
        <PermissionGate resource="files" action="read">
            <div className="mx-auto max-w-3xl">
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Brand</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    {importing && brand?.sourceValue
                        ? `Reading ${brand.sourceValue.replace(/^https:\/\//, '').replace(/\/$/, '')}… you can leave this page.`
                        : `How ${brand?.name || 'your brand'} sounds and looks. Every ad Olmo makes follows it.`}
                </p>
                {isLoading ? null
                    : importing && !hasContent ? <Shimmer />
                    : !hasContent ? (
                        <BrandEmptyState chatHref={chatHref} busy={startImport.isPending} failed={brand?.importStatus === 'failed'}
                            onSubmit={(v) => startImport.mutate(v)} />
                    ) : (
                        <>
                            {brand!.importStatus === 'failed' && <p className="pt-4 text-sm text-destructive">{FAILED_COPY}</p>}
                            <BrandForm brand={brand!} onSave={(p) => save.mutate(p)} onUploadImage={uploadImage}
                                onRefresh={() => brand!.sourceValue && startImport.mutate(brand!.sourceValue)}
                                refreshing={importing || startImport.isPending} />
                        </>
                    )}
            </div>
        </PermissionGate>
    );
}
```

- [ ] **Step 7: Sidebar and rename**

In `apps/web/lib/sidebar-items.ts`, after the Drive item:

```ts
    items.push({ label: "Brand", href: `${base}/brand`, icon: Sparkles });
```

Add `Sparkles` to the `lucide-react` import at the top. Change the existing settings item's label from `"Branding"` to `"Workspace look"`; leave its `href`, `icon`, plan gate and `locked` unchanged. Then `git grep -n "Branding" -- apps/web` and update any test or heading that asserts the old sidebar label (leave the `/branding` page's own content alone).

- [ ] **Step 8: Chat `?prefill=` support**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`, after `const [inputPrefill, setInputPrefill] = useState('');` add:

```tsx
    // ?prefill=… (e.g. the Brand page's "Tell Olmo about your brand") puts text
    // in the composer once; the user still presses send.
    useEffect(() => {
        const prefill = searchParams.get('prefill');
        if (prefill) setInputPrefill(prefill.slice(0, 500));
    }, [searchParams]);
```

Then make sure every `<ChatInput` in this file receives `prefill={inputPrefill}`: the one at the welcome `WizardView`, the one inside `CreativeEmptyState`, and the in-conversation one (which already has it). Add the prop where it is missing. Check `ChatInput`'s `prefill` handling (`git grep -n "prefill" -- apps/web/components`) to confirm it only seeds the input when the value changes.

- [ ] **Step 9: Type-check and run web tests**

Run (in `apps/web`): `npx tsc --noEmit && npx vitest run components/platform/brand`
Expected: no type errors; tests PASS.

- [ ] **Step 10: Look at it in both themes**

Run the web app locally (`pnpm -C apps/web dev`) against the dev API, open `/{tenant}/dashboard/brand`, and check: empty state, the shimmer while importing, the filled page, light and dark themes, phone width (no sideways scroll), the sidebar "Brand" item and "Workspace look" under Settings, and the chat link opening chat with "Set up my brand" typed. Note anything off and fix it before committing.

- [ ] **Step 11: Commit**

```bash
git add apps/web/components/platform/brand apps/web/app/\[tenant\]/dashboard/brand apps/web/lib/sidebar-items.ts apps/web/app/\[tenant\]/dashboard/chat/page.tsx
git commit -m "feat(web): Brand page — paste a site or handle, AI fills, edit inline; sidebar entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Whole-branch verification and live test

**Files:** none new.

- [ ] **Step 1: Full test runs**

```bash
pnpm -C products/agent-platform/packages/api exec vitest run
pnpm -C apps/agent-orchestrator exec vitest run
pnpm -C apps/web exec vitest run
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/agent-orchestrator exec tsc --noEmit
```
Expected: API shows only the two `origin/main` failures (`officialSkillsSeed`, `personas`); orchestrator and web all pass; no type errors.

- [ ] **Step 2: Live test on dev (after the user approves deploying)**

Deploy in the spec's order (migration; `TIKHUB_API_KEY` in the VM's `apps/agent-orchestrator/.env`; orchestrator build + `pm2 restart`; `sam build && sam deploy` from the main checkout after merge; `./deploy.sh`). Then, through the internal test MCP:
1. Import a D2C website; the Brand page fills within a minute, logo and colours present.
2. Import an Instagram-only brand by `@handle`.
3. Import a site that blocks us; the page shows the failure line and the chat link.
4. Edit the audience, press Refresh; the edit survives.
5. In chat, "make a 15s ad for <product>"; the end card has the brand logo and the copy follows the tone and banned phrases. Then "no logo on this one"; the next end card has none and the Brand page still shows the logo.

Report each result with the run ids; do not mark the feature done on unit tests alone.
