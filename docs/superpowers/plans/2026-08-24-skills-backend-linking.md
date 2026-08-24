# Skills Backend Linking + Test-in-Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cosmetic parts of the Skills feature (author, runs, downloads, files, install button) with real backend-linked data, make attaching a skill forward its actual SKILL.md content to the agent, and add a "Test in chat" action.

**Architecture:** All five phases are additive changes to existing routes and components — no new services. Two new integer counters (`skills.download_count`, global; `skill_installs.run_count`, per-tenant) are written at the existing install and chat-stream call sites; one new read-only S3 listing endpoint (`GET /skills/:id/files`) reads the `skill-packages/{skillId}/{version}/` prefix the import worker already writes. On the web side, `SkillCard`/`SkillDetailContent` stay presentational and receive new fields and callbacks as props, with fetching and mutation kept in `page.tsx` and `SkillDetailModal.tsx`.

**Tech Stack:** pnpm workspaces monorepo; Hono on AWS Lambda (`products/agent-platform/packages/api`); Drizzle ORM + Supabase Postgres (`packages/foundation/database`); Next.js App Router + Tailwind + shadcn/ui (`apps/web`); Hono + Mastra on GCP VM (`apps/agent-orchestrator`); Vitest for all tests; `@aws-sdk/client-s3` for storage.

**Spec:** `docs/superpowers/specs/2026-08-24-skills-backend-linking-design.md`

## Global Constraints

These apply to every task in this plan. A task's requirements implicitly include this section.

- **Tenancy:** "Don't bypass tenancy checks. Every DB query must filter by `tenantId`. The `tenantResolution` middleware sets `c.get('tenantId')`." (repo `CLAUDE.md`). In the agent-platform routes the tenant id is read as `(c.get('requestContext') as any)?.tenant?.id`.
- **`download_count` is global, not per-tenant:** it lives on the `skills` table and is "global across all tenants (mirrors how the card already shows global badges like Official/Community, not per-tenant state)". It is "Incremented in `POST /skills/:id/install` on every successful install, regardless of whether the installing tenant had installed it before."
- **"Downloads" means "times installed, counted globally" — there is no separate download action in the product, so install is the download event.**
- **`run_count` is per-tenant:** new column `skill_installs.run_count` (int, default 0) — "tenant-scoped, matching what the card displays per-install."
- **Out of scope — do not build:** "Multi-file *editing/versioning* UI — Phase D is read-only listing." / "Any change to the skill package/import format." / "A dedicated 'default agent' concept/flag — reusing existing (imperfect) fallback intentionally."
- **Default-agent resolution is a reuse, not an invention:** it must be exactly `activeAgents.find(a => a.isDefault) ?? activeAgents[0]`, as in `apps/web/app/[tenant]/dashboard/chat/useChatPage.ts`.
- **Zero-agent error copy is a reuse:** "If the tenant has zero active agents, show the same 'No active agents available' error the existing New Chat flow uses — no new error UX to design." The exact string is `No active agents available. Please create one first.`
- **Foundation vs Product rule** (`CLAUDE.md`): all skills code is *product* code. It goes in `products/agent-platform/*`, `apps/web`, or `apps/agent-orchestrator` — never in `packages/foundation/*` (the one exception is the shared Drizzle migration output directory, which is where drizzle-kit writes by design).
- **Migrations** are generated, never hand-numbered: `cd packages/foundation/database && pnpm exec drizzle-kit generate` then `pnpm exec drizzle-kit migrate`.

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `apps/web/components/platform/skills/SkillCard.test.tsx` | Component test: install button fires `onInstall` without bubbling to the card's `onClick`; real run/download counts render. |
| `apps/web/components/platform/skills/SkillDetailContent.test.tsx` | Component test: Author row, Runs row, Files list, Test button. |
| `apps/web/components/platform/skills/actions.test.ts` | Unit test for the non-React action helpers (`attachSkillToAgent`, `resolveDefaultAgent`, `startSkillTestChat`, `listSkillFiles`). |
| `products/agent-platform/packages/api/__tests__/skills.files.test.ts` | Integration test for `GET /skills/:id/files` (needs its own `@aws-sdk/client-s3` mock, so it is kept out of `skills.test.ts`). |
| `packages/foundation/database/migrations/00NN_*.sql` (×2, generated) | `skills.download_count` and `skill_installs.run_count` columns. |

### Modified

| File | Change |
|---|---|
| `products/agent-platform/packages/schema/skills.ts` | Add `downloadCount` to `skills`, `runCount` to `skillInstalls`. |
| `products/agent-platform/packages/api/routes/skills.ts` | Owner name/email on list + detail; `runCount`/`downloadCount` on list + detail; download increment on install; new `GET /:id/files`. |
| `products/agent-platform/packages/api/routes/agent-skills.ts` | `POST /:agentId/skills` derives `systemPrompt` server-side from the pinned installed version's manifest body. |
| `products/agent-platform/packages/api/__tests__/skills.test.ts` | Extend the shared `dbMock` and the list mock chain; add owner/count assertions. |
| `products/agent-platform/packages/api/__tests__/agent-skills.test.ts` | Add server-derived-`systemPrompt` assertions. |
| `apps/agent-orchestrator/src/usage.ts` | `fetchAgentSkill` also returns `installId`; new `recordSkillRun`. |
| `apps/agent-orchestrator/src/usage.test.ts` | Tests for the above. |
| `apps/agent-orchestrator/src/routes/chatStream.ts` | Fire-and-forget `recordSkillRun` at the existing `fetchAgentSkill` call site. |
| `apps/web/vitest.config.ts` | Include `*.test.tsx`, enable `globals` so React Testing Library auto-cleanup runs. |
| `apps/web/package.json` | Add `@testing-library/react`, `@testing-library/user-event`, `jsdom` devDependencies. |
| `apps/web/components/platform/skills/types.ts` | Add `ownerName`, `ownerEmail`, `runCount`, `downloadCount` to `Skill`; add `SkillFile`. |
| `apps/web/components/platform/skills/actions.ts` | Add `listSkillFiles`, `attachSkillToAgent`, `resolveDefaultAgent`, `startSkillTestChat`. |
| `apps/web/components/platform/skills/SkillCard.tsx` | Card root becomes a `div[role=button]`; real nested Install `<button>`; real counts. |
| `apps/web/components/platform/skills/SkillDetailContent.tsx` | Real Author + Runs rows; real Files list; Test button. |
| `apps/web/components/platform/skills/SkillDetailModal.tsx` | Fetch files + agents; `handleTest`; pass new props down. |
| `apps/web/components/platform/skills/AttachSkillPicker.tsx` | Stop sending `systemPrompt`; use `attachSkillToAgent`. |
| `apps/web/app/[tenant]/dashboard/skills/page.tsx` | Wire the card's `onInstall` to `installSkill`. |

---

## Task 1: Real owner info on the skills API (Phase A, backend)

**Files:**
- Modify: `products/agent-platform/packages/api/routes/skills.ts` (list handler ~lines 96-165; detail handler ~lines 171-222)
- Test: `products/agent-platform/packages/api/__tests__/skills.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /skills` and `GET /skills/:id` rows gain
  `ownerName: string | null` and `ownerEmail: string | null`.
  `ownerEmail` is non-null only when `skill.ownerTenantId === tenantId`
  (same owner-gating rule already applied to `failureReason`), so a public
  skill's author email never leaks cross-tenant. `skills.createdBy` is
  **not** added to the response payload.

- [ ] **Step 1: Write the failing tests**

Add to `products/agent-platform/packages/api/__tests__/skills.test.ts`. First replace the existing `mockList` helper inside `describe('GET /skills', ...)` (currently ~lines 129-138) with this version, which serves both the joined list query and the new batched `users` query:

```ts
  function mockList(
    rows: Record<string, unknown>[],
    versionRows: Record<string, unknown>[],
    ownerRows: Record<string, unknown>[] = [],
  ) {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === users) return { where: async () => ownerRows };
        return { leftJoin: () => ({ where: () => ({ orderBy: async () => rows }) }) };
      },
    }));
    dbMock.selectDistinctOn.mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: async () => versionRows }) }),
    }));
  }
```

Add the `users` import at the top of the file, next to the existing schema imports:

```ts
import { users } from '@serverless-saas/database/schema/auth';
```

Then append these two tests inside `describe('GET /skills', ...)`:

```ts
  it('returns the creating user as ownerName, with ownerEmail for the owning tenant', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=mine');
    const body = await res.json();
    expect(body.data[0].ownerName).toBe('Ada Lovelace');
    expect(body.data[0].ownerEmail).toBe('ada@example.com');
    expect(body.data[0].createdBy).toBeUndefined();
  });

  it("hides another tenant's owner email on the public tab but still names the author", async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: 'tenant-2', createdBy: 'user-9', installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=public');
    const body = await res.json();
    expect(body.data[0].ownerName).toBe('Ada Lovelace');
    expect(body.data[0].ownerEmail).toBeNull();
  });
```

And append a new describe block at the end of the file for the detail route:

```ts
describe('GET /skills/:id — owner info', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves ownerName/ownerEmail from skills.createdBy', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, createdBy: 'user-9', latestVersion: 1, visibility: 'private', isOfficial: false }] }) };
        if (table === users) return { where: () => ({ limit: async () => [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }] }) };
        if (table === skillInstalls) return { where: () => ({ limit: async () => [] }) };
        if (table === skillVersions) return { where: () => ({ orderBy: () => ({ limit: async () => [{ status: 'ready', failureReason: null, manifest: { body: '# Hi' } }] }) }) };
        throw new Error('unexpected select target');
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ownerName).toBe('Ada Lovelace');
    expect(body.data.ownerEmail).toBe('ada@example.com');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: FAIL — the new assertions report `undefined` for `ownerName`/`ownerEmail`.

- [ ] **Step 3: Write the implementation**

In `products/agent-platform/packages/api/routes/skills.ts`, add the `users` import below the existing `auditLog` import:

```ts
import { users } from '@serverless-saas/database/schema/auth';
```

Add this helper immediately after `resolveSkill` (~line 47):

```ts
// The creator's display name is safe to show anyone who can already see the
// skill; their email is not, so it follows the same owner-only rule the
// versions/list routes apply to failureReason.
async function resolveOwners(userIds: string[]): Promise<Map<string, { name: string; email: string }>> {
  const byId = new Map<string, { name: string; email: string }>();
  if (userIds.length === 0) return byId;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const row of rows) byId.set(row.id, { name: row.name, email: row.email });
  return byId;
}
```

In the `GET /skills` handler, add `createdBy` to the selected columns (inside the `.select({ ... })` object, after `ownerTenantId: skills.ownerTenantId,`):

```ts
        createdBy: skills.createdBy,
```

After the `latestBySkill` block and before the `return c.json({...})`, add:

```ts
    const ownerById = await resolveOwners([...new Set(rows.map((r) => r.createdBy).filter(Boolean))]);
```

Replace the `rows.map` body in the list response with:

```ts
      data: rows.map((r) => {
        const latest = latestBySkill.get(r.id);
        const { createdBy, ...rest } = r;
        const owner = ownerById.get(createdBy);
        return {
          ...rest,
          installed: r.installStatus === 'active',
          latestVersionStatus: latest?.status ?? null,
          ownerName: owner?.name ?? null,
          ownerEmail: r.ownerTenantId === tenantId ? (owner?.email ?? null) : null,
          // failureReason can carry raw, tenant-specific detail (a blocked
          // hostname, manifest/zip contents) for several failure classes —
          // see GET /:id/versions below, which strips it from non-owners the
          // same way. latestVersionStatus stays visible to everyone; only the
          // free-text reason is owner-gated.
          failureReason: r.ownerTenantId === tenantId ? (latest?.failureReason ?? null) : null,
        };
      }),
```

In the `GET /skills/:id` handler, after the `latest` lookup and before the `body` computation, add:

```ts
    const ownerById = await resolveOwners([skill.createdBy]);
    const owner = ownerById.get(skill.createdBy);
```

and add these two fields to the returned `data` object, right after `ownerTenantId: skill.ownerTenantId,`:

```ts
        ownerName: owner?.name ?? null,
        ownerEmail: isOwner ? (owner?.email ?? null) : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: PASS (all pre-existing tests in the file still pass too).

- [ ] **Step 5: Type-check and commit**

```bash
pnpm --filter @serverless-saas/agent-api run type-check
git add products/agent-platform/packages/api/routes/skills.ts products/agent-platform/packages/api/__tests__/skills.test.ts
git commit -m "feat(skills): return real owner name/email from the skills API"
```

---

## Task 2: Real Install button + Author row (Phase A, web)

**Files:**
- Modify: `apps/web/package.json`, `apps/web/vitest.config.ts`
- Modify: `apps/web/components/platform/skills/types.ts`
- Modify: `apps/web/components/platform/skills/SkillCard.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailContent.tsx` (Author `MetaRow`, ~line 73)
- Modify: `apps/web/app/[tenant]/dashboard/skills/page.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailModal.tsx` (pass-through only, see Step 5)
- Create: `apps/web/components/platform/skills/SkillCard.test.tsx`
- Create: `apps/web/components/platform/skills/SkillDetailContent.test.tsx`

**Interfaces:**
- Consumes: `ownerName: string | null`, `ownerEmail: string | null` from Task 1.
- Produces:
  - `Skill` (in `types.ts`) gains `ownerName: string | null` and `ownerEmail: string | null`.
  - `SkillCardProps` becomes `{ skill: Skill; onClick: () => void; onInstall: () => void }`.
  - `SkillDetailContent` props gain nothing in this task; its Author row reads `skill.ownerName`/`skill.ownerEmail`.
  - React component tests are now runnable: files matching `components/**/*.test.tsx` with a `/** @vitest-environment jsdom */` docblock.

- [ ] **Step 1: Install the component-test toolchain**

The web app currently has no React component test setup (`vitest.config.ts` is `environment: 'node'` and only includes `*.test.ts`). Add it:

```bash
pnpm --filter @serverless-saas/web add -D @testing-library/react@^16.3.0 @testing-library/user-event@^14.6.1 jsdom@^26.1.0
```

Replace `apps/web/vitest.config.ts` with:

```ts
import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    name: 'web',
    // Default stays node so the existing lib/hooks tests are unaffected.
    // Component tests opt in per-file with a `@vitest-environment jsdom`
    // docblock. globals is on so React Testing Library's auto-cleanup runs
    // between tests.
    environment: 'node',
    globals: true,
    include: ['{lib,components,hooks}/**/*.test.{ts,tsx}'],
  },
})
```

Verify the existing suite still passes:

Run: `pnpm --filter @serverless-saas/web exec vitest run`
Expected: PASS (the pre-existing `lib`/`hooks` tests).

- [ ] **Step 2: Write the failing tests**

Create `apps/web/components/platform/skills/SkillCard.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillCard } from "./SkillCard";
import type { Skill } from "./types";

afterEach(cleanup);

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        name: "PDF Tools",
        slug: "pdf-tools-abc123",
        description: "Work with PDFs",
        visibility: "public",
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: "tenant-1",
        ownerName: "Ada Lovelace",
        ownerEmail: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: null,
        installedVersion: null,
        installed: false,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        ...overrides,
    };
}

describe("SkillCard install button", () => {
    it("calls onInstall without also opening the detail modal", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        await userEvent.click(screen.getByRole("button", { name: /install/i }));

        expect(onInstall).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("still opens the detail modal when the card body is clicked", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        await userEvent.click(screen.getByText("Work with PDFs"));

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onInstall).not.toHaveBeenCalled();
    });

    it("hides the install button once the skill is installed", () => {
        render(
            <SkillCard
                skill={makeSkill({ installed: true, installedVersion: 2, installId: "install-1" })}
                onClick={vi.fn()}
                onInstall={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: /install$/i })).toBeNull();
        expect(screen.getByText("installed")).toBeTruthy();
    });
});
```

Create `apps/web/components/platform/skills/SkillDetailContent.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SkillDetailContent } from "./SkillDetailContent";
import type { Skill } from "./types";

vi.mock("@/components/platform/canvas/MarkdownViewer", () => ({
    MarkdownViewer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

afterEach(cleanup);

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        name: "PDF Tools",
        slug: "pdf-tools-abc123",
        description: "Work with PDFs",
        visibility: "public",
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: "tenant-1",
        ownerName: "Ada Lovelace",
        ownerEmail: "ada@example.com",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: null,
        installedVersion: null,
        installed: false,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        body: null,
        ...overrides,
    };
}

const noop = () => {};

describe("SkillDetailContent author row", () => {
    it("shows the creator's name", () => {
        render(
            <SkillDetailContent
                skill={makeSkill()}
                isOwner={false}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    });

    it("falls back to the email, then to Unknown, when the name is missing", () => {
        const { unmount } = render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null })}
                isOwner
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("ada@example.com")).toBeTruthy();
        unmount();

        render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null, ownerEmail: null })}
                isOwner={false}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("Unknown")).toBeTruthy();
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills`
Expected: FAIL — `SkillCard` has no `onInstall` prop (TypeScript/runtime error, and no accessible Install button), and `SkillDetailContent` renders "Community" in the Author row instead of "Ada Lovelace".

- [ ] **Step 4: Add the new fields to the web `Skill` type**

In `apps/web/components/platform/skills/types.ts`, add to the `Skill` interface immediately after `ownerTenantId: string;`:

```ts
    /** Display name of the user who created the skill. Null if the creator row is gone. */
    ownerName: string | null;
    /** Creator's email — only populated for the owning tenant; null cross-tenant. */
    ownerEmail: string | null;
```

- [ ] **Step 5: Make the card's Install a real button**

Replace `apps/web/components/platform/skills/SkillCard.tsx` entirely with:

```tsx
import { ArrowUp, Download, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillIcon } from "./SkillIcon";
import type { Skill } from "./types";

interface SkillCardProps {
    skill: Skill;
    onClick: () => void;
    onInstall: () => void;
}

// A failed import leaves latestVersion at 0 forever, exactly like a still-running
// one — so the version number alone can't tell them apart. Branch on the newest
// version row's own status instead. Shared with the skill detail page so both
// agree on install/failed/importing state.
export function skillImportState(skill: Skill) {
    const importFailed = skill.latestVersionStatus === "failed";
    const hasReadyVersion = skill.latestVersion >= 1;
    const dead = importFailed && !hasReadyVersion;
    const importing = !importFailed && !hasReadyVersion;
    return { importFailed, hasReadyVersion, dead, importing };
}

export function SkillCard({ skill, onClick, onInstall }: SkillCardProps) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);

    // Importing/failed are transient — shown as a badge up top where the Install
    // control normally sits, instead of alongside the permanent visibility badge.
    const transientStatus = importFailed
        ? {
            label: dead ? "Failed" : "Update failed",
            className: "border-destructive/30 text-destructive dark:border-destructive/40",
        }
        : importing
            ? {
                label: "Importing",
                className: "border-amber-600/30 text-amber-700 dark:border-amber-500/30 dark:text-amber-400",
            }
            : null;

    const visibilityStatus = skill.isOfficial
        ? {
            label: "Official",
            className: "border-indigo-600/30 text-indigo-700 dark:border-indigo-500/30 dark:text-indigo-400",
        }
        : skill.visibility === "public"
            ? {
                label: "Community",
                className: "border-teal-600/30 text-teal-700 dark:border-teal-500/30 dark:text-teal-400",
            }
            : {
                label: "Private",
                className: "border-border text-muted-foreground",
            };

    return (
        // Not a <button>: the Install control below is a real nested button, and
        // HTML forbids nesting interactive elements. role/tabIndex/onKeyDown keep
        // the whole card keyboard-operable exactly as the <button> was.
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onClick();
                }
            }}
            className="block w-full cursor-pointer text-left"
        >
            <Card className="h-full transition-colors hover:border-input">
                <CardContent className="pt-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <SkillIcon seed={skill.id} className="h-12 w-12 rounded-lg border border-border shrink-0" />
                            <div className="min-w-0 space-y-1">
                                <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                                <Badge variant="outline" className={cn("text-[10px] font-semibold uppercase tracking-wider", visibilityStatus.className)}>
                                    {visibilityStatus.label}
                                </Badge>
                            </div>
                        </div>
                        {transientStatus && (
                            <Badge variant="outline" className={cn("text-[11px] font-semibold uppercase tracking-wider shrink-0", transientStatus.className)}>
                                {transientStatus.label}
                            </Badge>
                        )}
                    </div>

                    <p className="text-sm text-muted-foreground line-clamp-2">
                        {skill.description ?? "No description"}
                    </p>

                    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1">
                                <ArrowUp className="h-3.5 w-3.5" />
                                {/* Run counts aren't tracked yet. */}
                                — runs
                            </span>
                            <span className="flex items-center gap-1">
                                <Download className="h-3.5 w-3.5" />
                                {/* Download counts aren't tracked yet. */}
                                —
                            </span>
                            {hasReadyVersion && (
                                <span className="flex items-center gap-1">
                                    <Package className="h-3.5 w-3.5" />
                                    v{skill.latestVersion}
                                </span>
                            )}
                        </div>

                        {skill.installed ? (
                            <span className="text-green-600 dark:text-green-500 shrink-0">
                                {skill.installedVersion !== skill.latestVersion
                                    ? `installed v${skill.installedVersion}`
                                    : "installed"}
                            </span>
                        ) : !transientStatus ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                className="shrink-0"
                                onClick={(e) => {
                                    // Without this the card's own onClick fires too and the
                                    // detail modal opens on top of the install.
                                    e.stopPropagation();
                                    onInstall();
                                }}
                            >
                                <Download />
                                Install
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
```

(The `— runs` / `—` placeholders are replaced in Task 6; leave them for now so this task stays independently reviewable.)

- [ ] **Step 6: Render the real author**

In `apps/web/components/platform/skills/SkillDetailContent.tsx`, replace the Author `MetaRow` (currently line 73):

```tsx
                <MetaRow icon={User} label="Author" value={skill.ownerName ?? skill.ownerEmail ?? "Unknown"} />
```

- [ ] **Step 7: Wire the card's install handler on the skills page**

In `apps/web/app/[tenant]/dashboard/skills/page.tsx`, extend the imports:

```tsx
import { toast } from "sonner";
import { installSkill, listSkills } from "@/components/platform/skills/actions";
```

(remove the now-duplicated `import { listSkills } from "@/components/platform/skills/actions";` line).

Inside `SkillsPage`, after the `publicSkills` declarations, add:

```tsx
    const handleInstall = async (skillId: string) => {
        try {
            await installSkill(skillId);
            queryClient.invalidateQueries({ queryKey: ["skills"] });
            toast.success("Skill installed.");
        } catch {
            toast.error("Failed to install skill.");
        }
    };
```

Pass it to all three `<SkillGrid>` usages by adding `onInstall={handleInstall}` alongside the existing `onSelect={setSelectedSkillId}`.

Update the `SkillGrid` signature and the card render:

```tsx
function SkillGrid({
    skills,
    isLoading,
    onSelect,
    onInstall,
    emptyMessage,
}: {
    skills: Skill[];
    isLoading: boolean;
    onSelect: (skillId: string) => void;
    onInstall: (skillId: string) => void;
    emptyMessage: string;
}) {
```

```tsx
            {skills.map((skill) => (
                <SkillCard
                    key={skill.id}
                    skill={skill}
                    onClick={() => onSelect(skill.id)}
                    onInstall={() => onInstall(skill.id)}
                />
            ))}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills`
Expected: PASS — 5 tests.

- [ ] **Step 9: Type-check and commit**

```bash
pnpm --filter @serverless-saas/web run type-check
git add apps/web/package.json apps/web/vitest.config.ts pnpm-lock.yaml \
  apps/web/components/platform/skills/types.ts \
  apps/web/components/platform/skills/SkillCard.tsx \
  apps/web/components/platform/skills/SkillCard.test.tsx \
  apps/web/components/platform/skills/SkillDetailContent.tsx \
  apps/web/components/platform/skills/SkillDetailContent.test.tsx \
  "apps/web/app/[tenant]/dashboard/skills/page.tsx"
git commit -m "feat(skills): real install button on the card and real author row"
```

---

## Task 3: Attach forwards real SKILL.md content (Phase B)

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agent-skills.ts` (`resolveInstall` ~lines 28-39; `POST /:agentId/skills` ~lines 72-129)
- Modify: `products/agent-platform/packages/api/__tests__/agent-skills.test.ts`
- Modify: `apps/web/components/platform/skills/actions.ts`
- Modify: `apps/web/components/platform/skills/AttachSkillPicker.tsx`
- Create: `apps/web/components/platform/skills/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `POST /agents/:agentId/skills` request body becomes
    `{ name: string; systemPrompt?: string; tools?: string[]; config?: Record<string, unknown>; version?: number; installId?: string }`.
    When `installId` is present, `systemPrompt` is ignored and derived
    server-side; when absent, `systemPrompt` is required (400 otherwise).
    Returns 409 `{ code: 'NOT_READY' }` when the pinned version has no
    readable body.
  - `attachSkillToAgent(agentId: string, skill: Skill): Promise<void>` in
    `apps/web/components/platform/skills/actions.ts`. Throws
    `new Error("NO_INSTALL_ID")` when `skill.installId` is null; treats an
    HTTP 409 as success (the skill is already attached at that version).
    Task 8 reuses this exact function.

- [ ] **Step 1: Write the failing backend tests**

Append to `products/agent-platform/packages/api/__tests__/agent-skills.test.ts`. First add the `skillVersions` import at the top:

```ts
import { skillVersions } from '@serverless-saas/agent-schema/skills';
```

Then append this describe block:

```ts
describe('POST /agents/:agentId/skills — server-derived system prompt', () => {
    beforeEach(() => vi.clearAllMocks());

    const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
    const SKILL_BODY = '# PDF Tools\n\nUse pdftotext before answering.';

    function mockAttach(versionRows: Record<string, unknown>[]) {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 2 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => versionRows }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-row-1', ...data }] : [{ id: 'audit-1' }]),
                catch: () => {},
            }),
        }));
    }

    it("stores the installed version's manifest body, ignoring any client-supplied systemPrompt", async () => {
        mockAttach([{ status: 'ready', manifest: { body: SKILL_BODY } }]);

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', systemPrompt: 'a short description', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.systemPrompt).toBe(SKILL_BODY);
    });

    it('returns 409 NOT_READY when the pinned version has no readable body', async () => {
        mockAttach([{ status: 'pending', manifest: null }]);

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NOT_READY');
    });

    it('still requires systemPrompt for a hand-authored skill with no installId', async () => {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [{ id: 'agent-1' }] }) }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Custom Skill' }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });
});
```

Also update the existing test `'accepts installId and stores it on the created row when attaching an installed skill'` (currently ~lines 62-85): its `mockResolveAgent([...])` no longer supplies enough shape. Replace that whole `it(...)` block with:

```ts
    it('accepts installId and stores it on the created row when attaching an installed skill', async () => {
        const installId = '11111111-1111-4111-8111-111111111111';
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: installId, skillId: 'skill-1', installedVersion: 1 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => [{ status: 'ready', manifest: { body: '# Body' } }] }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-2', ...data }] : [{ id: 'audit-2' }]),
                catch: () => {},
            }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.installId).toBe(installId);
    });
```

- [ ] **Step 2: Run backend tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/agent-skills.test.ts`
Expected: FAIL — `systemPrompt` comes back as the client string, and omitting `systemPrompt` yields a Zod 400 with a different shape / a 201.

- [ ] **Step 3: Derive the system prompt server-side**

In `products/agent-platform/packages/api/routes/agent-skills.ts`, extend the schema import line:

```ts
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';
```

Replace `resolveInstall` (~lines 24-39) with:

```ts
// An installId names a skill_installs row, which is tenant-scoped. Writing a
// foreign tenant's install id would be a silent cross-tenant reference, so the
// lookup is scoped to this tenant and to active installs only. The row also
// carries the pinned version, which is what the system prompt is read from.
async function resolveInstall(installId: string, tenantId: string) {
    const [install] = await db
        .select({
            id: skillInstalls.id,
            skillId: skillInstalls.skillId,
            installedVersion: skillInstalls.installedVersion,
        })
        .from(skillInstalls)
        .where(and(
            eq(skillInstalls.id, installId),
            eq(skillInstalls.tenantId, tenantId),
            eq(skillInstalls.status, 'active'),
        ))
        .limit(1);
    return install ?? null;
}

// The body of the *pinned* version, not the latest — an install is npm-style
// pinned, so the agent must receive the content the tenant actually installed.
// Only a 'ready' row's manifest was written by a completed import; a
// pending/failed row's manifest is whatever the previous version left behind.
async function resolveInstalledSkillBody(skillId: string, version: number): Promise<string | null> {
    const [row] = await db
        .select({ manifest: skillVersions.manifest, status: skillVersions.status })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
        .limit(1);
    if (!row || row.status !== 'ready' || !row.manifest || typeof row.manifest !== 'object') return null;
    const body = (row.manifest as Record<string, unknown>).body;
    return typeof body === 'string' && body.length > 0 ? body : null;
}
```

In `POST /:agentId/skills`, make `systemPrompt` optional in the Zod schema:

```ts
    const schema = z.object({
        name: z.string().min(1).max(100),
        // Optional because an installed skill's prompt is derived server-side
        // from its manifest body — the client must not be able to supply (or
        // stale-cache) the content the agent runs on.
        systemPrompt: z.string().min(1).optional(),
        tools: z.array(z.string()).optional().default([]),
        config: z.record(z.unknown()).optional(),
        version: z.number().int().positive().optional(),
        installId: z.string().uuid().optional(),
    });
```

Replace the body of the `try` block's install check + insert (currently lines 103-117) with:

```ts
        let systemPrompt: string;
        if (result.data.installId) {
            const install = await resolveInstall(result.data.installId, tenantId);
            if (!install) {
                return c.json({ error: 'Skill install not found', code: 'NOT_FOUND' }, 404);
            }
            const body = await resolveInstalledSkillBody(install.skillId, install.installedVersion);
            if (!body) {
                return c.json({ error: 'Skill version has no readable content yet', code: 'NOT_READY' }, 409);
            }
            systemPrompt = body;
        } else {
            if (!result.data.systemPrompt) {
                return c.json({ error: 'systemPrompt is required when installId is omitted', code: 'VALIDATION_ERROR' }, 400);
            }
            systemPrompt = result.data.systemPrompt;
        }

        const [created] = await db.insert(agentSkills).values({
            agentId,
            tenantId,
            name: result.data.name,
            systemPrompt,
            tools: result.data.tools,
            config: result.data.config ?? null,
            version: result.data.version ?? 1,
            status: 'active',
            installId: result.data.installId ?? null,
        }).returning();
```

- [ ] **Step 4: Run backend tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/agent-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing client-action test**

Create `apps/web/components/platform/skills/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => {
    class ApiError extends Error {
        constructor(public status: number, public data: unknown) {
            super(`API Error: ${status}`);
            this.name = "ApiError";
        }
    }
    return {
        ApiError,
        api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    };
});

import { api, ApiError } from "@/lib/api";
import { attachSkillToAgent } from "./actions";
import type { Skill } from "./types";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        name: "PDF Tools",
        slug: "pdf-tools-abc123",
        description: "Work with PDFs",
        visibility: "public",
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: "tenant-1",
        ownerName: "Ada Lovelace",
        ownerEmail: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: "11111111-1111-4111-8111-111111111111",
        installedVersion: 2,
        installed: true,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        ...overrides,
    };
}

describe("attachSkillToAgent", () => {
    beforeEach(() => vi.clearAllMocks());

    it("posts name and installId only — never a client-side systemPrompt", async () => {
        vi.mocked(api.post).mockResolvedValueOnce({});
        await attachSkillToAgent("agent-1", makeSkill());
        expect(api.post).toHaveBeenCalledWith("/api/v1/agents/agent-1/skills", {
            name: "PDF Tools",
            installId: "11111111-1111-4111-8111-111111111111",
        });
    });

    it("throws NO_INSTALL_ID when the skill has no install row", async () => {
        await expect(attachSkillToAgent("agent-1", makeSkill({ installId: null }))).rejects.toThrow("NO_INSTALL_ID");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("treats a 409 as success — the skill is already attached at that version", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, { code: "CONFLICT" }));
        await expect(attachSkillToAgent("agent-1", makeSkill())).resolves.toBeUndefined();
    });

    it("rethrows any other API failure", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(500, { code: "INTERNAL_ERROR" }));
        await expect(attachSkillToAgent("agent-1", makeSkill())).rejects.toBeInstanceOf(ApiError);
    });
});
```

- [ ] **Step 6: Run the client test to verify it fails**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills/actions.test.ts`
Expected: FAIL with "attachSkillToAgent is not a function" / import error.

- [ ] **Step 7: Add `attachSkillToAgent` and use it in the picker**

In `apps/web/components/platform/skills/actions.ts`, change the first import line to:

```ts
import { api, ApiError } from "@/lib/api";
```

and append at the end of the file:

```ts
/**
 * Attaches an installed skill to an agent. The system prompt is NOT sent — the
 * server derives it from the pinned skill_versions manifest body, so it can't be
 * spoofed or go stale. A 409 means the same skill+version is already attached,
 * which is the desired end state, so it resolves rather than throwing.
 */
export async function attachSkillToAgent(agentId: string, skill: Skill): Promise<void> {
    if (!skill.installId) throw new Error("NO_INSTALL_ID");
    try {
        await api.post(`/api/v1/agents/${agentId}/skills`, {
            name: skill.name,
            installId: skill.installId,
        });
    } catch (err) {
        if (err instanceof ApiError && err.status === 409) return;
        throw err;
    }
}
```

In `apps/web/components/platform/skills/AttachSkillPicker.tsx`, remove the now-unused `api` import and change the actions import:

```tsx
import { attachSkillToAgent, listSkills } from "./actions";
```

(delete the line `import { api } from "@/lib/api";`).

Replace `handleAttach` (currently lines 35-58) with:

```tsx
    const handleAttach = async (skill: Skill) => {
        setAttachingId(skill.id);
        try {
            // installId is skill_installs.id — the row agentSkills.installId is an
            // FK to. skill.id is a different row entirely. The server reads the real
            // SKILL.md body off that install's pinned version, so nothing about the
            // skill content is sent from here.
            await attachSkillToAgent(agentId, skill);
            toast.success(`${skill.name} attached.`);
            onAttached();
            onOpenChange(false);
        } catch (err) {
            if (err instanceof Error && err.message === "NO_INSTALL_ID") {
                toast.error("This skill has no install record — reinstall it from the Skills page first.");
            } else {
                toast.error("Failed to attach skill.");
            }
        } finally {
            setAttachingId(null);
        }
    };
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills && pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/agent-skills.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check and commit**

```bash
pnpm --filter @serverless-saas/agent-api run type-check
pnpm --filter @serverless-saas/web run type-check
git add products/agent-platform/packages/api/routes/agent-skills.ts \
  products/agent-platform/packages/api/__tests__/agent-skills.test.ts \
  apps/web/components/platform/skills/actions.ts \
  apps/web/components/platform/skills/actions.test.ts \
  apps/web/components/platform/skills/AttachSkillPicker.tsx
git commit -m "feat(skills): attach forwards the real SKILL.md body to the agent"
```

---

## Task 4: Global download counts (Phase C, downloads)

**Files:**
- Modify: `products/agent-platform/packages/schema/skills.ts` (`skills` table, ~lines 13-29)
- Modify: `products/agent-platform/packages/api/routes/skills.ts` (list select; detail response; `POST /skills/:id/install` ~lines 367-400)
- Modify: `products/agent-platform/packages/api/__tests__/skills.test.ts`
- Create (generated): `packages/foundation/database/migrations/00NN_<name>.sql`

**Interfaces:**
- Consumes: `resolveOwners` and the extended `mockList` helper from Task 1.
- Produces:
  - Drizzle column `downloadCount: integer('download_count').notNull().default(0)` on `skills`.
  - `GET /skills` and `GET /skills/:id` rows gain `downloadCount: number` (never null — the column is `NOT NULL DEFAULT 0`).

- [ ] **Step 1: Write the failing tests**

In `products/agent-platform/packages/api/__tests__/skills.test.ts`, extend the hoisted db mock (line 5) to include `execute`:

```ts
const dbMock = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
```

Append this describe block at the end of the file:

```ts
describe('download_count', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes downloadCount on the list response', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: null, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=mine');
    expect((await res.json()).data[0].downloadCount).toBe(42);
  });

  it('increments skills.download_count on every successful install, globally', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false, latestVersion: 3 }] }) };
        throw new Error('unexpected select target');
      },
    }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: 'install-1', installedVersion: 3 }] }),
        returning: async () => [{ id: 'audit-1' }],
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: FAIL — `downloadCount` is `undefined` and `dbMock.execute` was never called.

- [ ] **Step 3: Add the column and the migration**

In `products/agent-platform/packages/schema/skills.ts`, add to the `skills` table definition after `latestVersion`:

```ts
  // Global across all tenants — "times installed", the product's only download
  // event. Deliberately NOT per-tenant, unlike skill_installs.run_count.
  downloadCount: integer('download_count').notNull().default(0),
```

Generate and apply the migration:

```bash
cd packages/foundation/database && pnpm exec drizzle-kit generate --name skills_download_count
cd packages/foundation/database && pnpm exec drizzle-kit migrate
```

Confirm the generated file contains `ALTER TABLE "skills" ADD COLUMN "download_count" integer DEFAULT 0 NOT NULL;`.

- [ ] **Step 4: Expose and increment it**

In `products/agent-platform/packages/api/routes/skills.ts`, extend the drizzle-orm import:

```ts
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
```

Add `downloadCount` to the `GET /skills` select object, after `latestVersion: skills.latestVersion,`:

```ts
        downloadCount: skills.downloadCount,
```

In `GET /skills/:id`, add to the returned `data` object after `latestVersion: skill.latestVersion,`:

```ts
        downloadCount: skill.downloadCount,
```

In `POST /skills/:id/install`, insert this immediately after the `const [installed] = await db.insert(skillInstalls)...returning();` statement:

```ts
    // Raw SQL, not db.update(skills): the Drizzle column has $onUpdate on
    // updatedAt, so an ORM update would bump the skill's "Last update"
    // timestamp on every install. Fire-and-forget — a counter must never fail
    // the install itself.
    db.execute(sql`UPDATE skills SET download_count = download_count + 1 WHERE id = ${skillId}`)
      .catch((err: unknown) => console.error('Failed to increment skill download_count:', err));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

```bash
pnpm --filter @serverless-saas/agent-schema run type-check
pnpm --filter @serverless-saas/agent-api run type-check
git add products/agent-platform/packages/schema/skills.ts \
  products/agent-platform/packages/api/routes/skills.ts \
  products/agent-platform/packages/api/__tests__/skills.test.ts \
  packages/foundation/database/migrations
git commit -m "feat(skills): track global download_count on install"
```

---

## Task 5: Per-tenant run counts (Phase C, runs)

**Files:**
- Modify: `products/agent-platform/packages/schema/skills.ts` (`skillInstalls` table, ~lines 51-63)
- Modify: `products/agent-platform/packages/api/routes/skills.ts` (list select; detail response)
- Modify: `products/agent-platform/packages/api/__tests__/skills.test.ts`
- Modify: `apps/agent-orchestrator/src/usage.ts` (`AgentSkill` ~lines 39-43, `fetchAgentSkill` ~lines 45-60)
- Modify: `apps/agent-orchestrator/src/usage.test.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts` (~lines 194-205)
- Create (generated): `packages/foundation/database/migrations/00NN_<name>.sql`

**Interfaces:**
- Consumes: the extended `mockList` helper from Task 1; the `execute`-capable `dbMock` from Task 4.
- Produces:
  - Drizzle column `runCount: integer('run_count').notNull().default(0)` on `skillInstalls`.
  - `GET /skills` and `GET /skills/:id` rows gain `runCount: number` — `0` when this tenant has no install row (the left join yields null).
  - `interface AgentSkill { systemPrompt: string | null; tools: string[] | null; config: unknown; installId: string | null }` in `apps/agent-orchestrator/src/usage.ts`.
  - `export async function recordSkillRun(installId: string, tenantId: string): Promise<void>` in the same file.

- [ ] **Step 1: Write the failing API test**

Append to `products/agent-platform/packages/api/__tests__/skills.test.ts`:

```ts
describe('run_count', () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes this tenant's runCount from its own install row", async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: 'active', installId: 'install-1', runCount: 7, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=installed');
    expect((await res.json()).data[0].runCount).toBe(7);
  });

  it('reports runCount 0 when this tenant has no install row', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: 'tenant-2', createdBy: 'user-9', installStatus: null, installId: null, runCount: null, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=public');
    expect((await res.json()).data[0].runCount).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing orchestrator tests**

Append to `apps/agent-orchestrator/src/usage.test.ts`. First extend the import on line 9:

```ts
import { fetchToolGovernance, fetchAgentModelSelection, fetchAgentPersonality, fetchAgentMemory, fetchAgentSkill, recordSkillRun } from './usage.js'
```

Then append:

```ts
describe('fetchAgentSkill', () => {
  it('returns the install id so the caller can attribute the run to a tenant install', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ system_prompt: '# PDF Tools', tools: ['pdftotext'], config: null, install_id: 'install-1' }],
    })
    const result = await fetchAgentSkill('agent-1')
    expect(result).toEqual({ systemPrompt: '# PDF Tools', tools: ['pdftotext'], config: null, installId: 'install-1' })
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('install_id'), ['agent-1'])
  })

  it('returns null when the agent has no active skill', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    expect(await fetchAgentSkill('agent-2')).toBeNull()
  })
})

describe('recordSkillRun', () => {
  it('increments run_count on the tenant-scoped install row', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await recordSkillRun('install-1', 'tenant-1')
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('run_count = run_count + 1'),
      ['install-1', 'tenant-1'],
    )
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('tenant_id = $2'), ['install-1', 'tenant-1'])
  })
})
```

- [ ] **Step 3: Run both suites to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: FAIL — `runCount` is `undefined`.

Run: `pnpm --filter agent-orchestrator exec vitest run src/usage.test.ts`
Expected: FAIL — `recordSkillRun` is not exported; `fetchAgentSkill` result has no `installId`.

- [ ] **Step 4: Add the column and the migration**

In `products/agent-platform/packages/schema/skills.ts`, add to the `skillInstalls` table after `autoUpdate`:

```ts
  // Per-tenant: incremented once per chat message sent while this install's
  // skill is attached to the agent. Tenant-scoped by construction, unlike
  // skills.download_count which is global.
  runCount: integer('run_count').notNull().default(0),
```

```bash
cd packages/foundation/database && pnpm exec drizzle-kit generate --name skill_installs_run_count
cd packages/foundation/database && pnpm exec drizzle-kit migrate
```

Confirm the generated file contains `ALTER TABLE "skill_installs" ADD COLUMN "run_count" integer DEFAULT 0 NOT NULL;`.

- [ ] **Step 5: Expose runCount on the API**

In `products/agent-platform/packages/api/routes/skills.ts`, add to the `GET /skills` select object after `installStatus: skillInstalls.status,`:

```ts
        runCount: skillInstalls.runCount,
```

In the list `rows.map`, add to the returned object (next to `ownerName`):

```ts
          runCount: r.runCount ?? 0,
```

In `GET /skills/:id`, add to the returned `data` object after `installed: install?.status === 'active',`:

```ts
        runCount: install?.runCount ?? 0,
```

- [ ] **Step 6: Implement the orchestrator side**

In `apps/agent-orchestrator/src/usage.ts`, replace the `AgentSkill` interface and `fetchAgentSkill` (lines 39-60) with:

```ts
export interface AgentSkill {
  systemPrompt: string | null
  tools: string[] | null
  config: unknown
  /** skill_installs.id when this agent_skills row came from an installed skill; null for hand-authored ones. */
  installId: string | null
}

export async function fetchAgentSkill(agentId: string): Promise<AgentSkill | null> {
  const p = getPool()
  const res = await p.query<{ system_prompt: string | null; tools: unknown; config: unknown; install_id: string | null }>(
    `SELECT system_prompt, tools, config, install_id FROM agent_skills
     WHERE agent_id = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [agentId],
  )
  const row = res.rows[0]
  if (!row) return null
  const rawTools = row.tools
  const tools = Array.isArray(rawTools)
    ? (rawTools as string[])
    : null
  return { systemPrompt: row.system_prompt, tools, config: row.config, installId: row.install_id }
}

// run_count is per-tenant, so the UPDATE is scoped by tenant_id as well as the
// install id — an install id from another tenant matches zero rows rather than
// crediting the wrong tenant's counter.
export async function recordSkillRun(installId: string, tenantId: string): Promise<void> {
  const p = getPool()
  await p.query(
    `UPDATE skill_installs SET run_count = run_count + 1, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [installId, tenantId],
  )
}
```

In `apps/agent-orchestrator/src/routes/chatStream.ts`, extend the import on line 11:

```ts
import { fetchAgentSkill, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection, recordSkillRun } from '../usage.js'
```

and insert this immediately after the `if (agentSkill?.systemPrompt) { ... }` block (~line 205):

```ts
    // One run per chat message sent while a skill is attached. Fire-and-forget:
    // a counter write must never break or delay the stream.
    if (agentSkill?.installId) {
      recordSkillRun(agentSkill.installId, tenantId)
        .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRun failed:`, (err as Error).message))
    }
```

- [ ] **Step 7: Run both suites to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.test.ts`
Expected: PASS.

Run: `pnpm --filter agent-orchestrator exec vitest run src/usage.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check and commit**

```bash
pnpm --filter @serverless-saas/agent-schema run type-check
pnpm --filter @serverless-saas/agent-api run type-check
pnpm --filter agent-orchestrator run type-check
git add products/agent-platform/packages/schema/skills.ts \
  products/agent-platform/packages/api/routes/skills.ts \
  products/agent-platform/packages/api/__tests__/skills.test.ts \
  apps/agent-orchestrator/src/usage.ts \
  apps/agent-orchestrator/src/usage.test.ts \
  apps/agent-orchestrator/src/routes/chatStream.ts \
  packages/foundation/database/migrations
git commit -m "feat(skills): track per-tenant run_count on every chat message"
```

---

## Task 6: Render real run and download counts (Phase C, UI)

**Files:**
- Modify: `apps/web/components/platform/skills/types.ts`
- Modify: `apps/web/components/platform/skills/SkillCard.tsx` (counts block, the two `—` placeholders)
- Modify: `apps/web/components/platform/skills/SkillDetailContent.tsx` (Runs `MetaRow`, currently `value="—"`)
- Modify: `apps/web/components/platform/skills/SkillCard.test.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailContent.test.tsx`

**Interfaces:**
- Consumes: `downloadCount: number` (Task 4) and `runCount: number` (Task 5) from the API.
- Produces: `Skill` (web) gains `runCount: number` and `downloadCount: number`. These are the exact field names every later task uses.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/components/platform/skills/SkillCard.test.tsx`:

```tsx
describe("SkillCard counts", () => {
    it("renders the real run and download counts", () => {
        render(
            <SkillCard
                skill={makeSkill({ runCount: 12, downloadCount: 340 })}
                onClick={vi.fn()}
                onInstall={vi.fn()}
            />,
        );
        expect(screen.getByText("12 runs")).toBeTruthy();
        expect(screen.getByText("340")).toBeTruthy();
    });

    it("renders zeroes rather than dashes for an untouched skill", () => {
        render(<SkillCard skill={makeSkill()} onClick={vi.fn()} onInstall={vi.fn()} />);
        expect(screen.getByText("0 runs")).toBeTruthy();
    });
});
```

Append to `apps/web/components/platform/skills/SkillDetailContent.test.tsx`:

```tsx
describe("SkillDetailContent runs row", () => {
    it("shows the tenant's run count", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ runCount: 12 })}
                isOwner
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("12")).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills`
Expected: FAIL — "Unable to find an element with the text: 12 runs".

- [ ] **Step 3: Add the fields to the web type**

In `apps/web/components/platform/skills/types.ts`, add to the `Skill` interface after `failureReason: string | null;`:

```ts
    /** Times a chat message ran with this skill attached, for THIS tenant only (skill_installs.run_count). 0 when never installed. */
    runCount: number;
    /** Times this skill has been installed, counted globally across all tenants (skills.download_count). */
    downloadCount: number;
```

- [ ] **Step 4: Render them**

In `apps/web/components/platform/skills/SkillCard.tsx`, replace the counts block:

```tsx
                        <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1">
                                <ArrowUp className="h-3.5 w-3.5" />
                                {skill.runCount} runs
                            </span>
                            <span className="flex items-center gap-1">
                                <Download className="h-3.5 w-3.5" />
                                {skill.downloadCount}
                            </span>
                            {hasReadyVersion && (
                                <span className="flex items-center gap-1">
                                    <Package className="h-3.5 w-3.5" />
                                    v{skill.latestVersion}
                                </span>
                            )}
                        </div>
```

In `apps/web/components/platform/skills/SkillDetailContent.tsx`, replace the Runs `MetaRow`:

```tsx
                <MetaRow icon={Zap} label="Runs" value={String(skill.runCount)} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

```bash
pnpm --filter @serverless-saas/web run type-check
git add apps/web/components/platform/skills/types.ts \
  apps/web/components/platform/skills/SkillCard.tsx \
  apps/web/components/platform/skills/SkillCard.test.tsx \
  apps/web/components/platform/skills/SkillDetailContent.tsx \
  apps/web/components/platform/skills/SkillDetailContent.test.tsx
git commit -m "feat(skills): render real run and download counts"
```

---

## Task 7: Real files listing (Phase D)

**Files:**
- Modify: `products/agent-platform/packages/api/routes/skills.ts` (new route, register next to `GET /:id/versions`)
- Create: `products/agent-platform/packages/api/__tests__/skills.files.test.ts`
- Modify: `apps/web/components/platform/skills/types.ts`
- Modify: `apps/web/components/platform/skills/actions.ts`
- Modify: `apps/web/components/platform/skills/SkillDetailModal.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailContent.tsx` (`SkillOverview` sidebar, ~lines 117-129)
- Modify: `apps/web/components/platform/skills/SkillDetailContent.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (the S3 layout `skill-packages/{skillId}/{version}/{fileName}` is already written by `skillImport.ts`).
- Produces:
  - `GET /api/v1/skills/:id/files` → `{ data: Array<{ fileName: string; size: number }> }`, sorted by `fileName`. Returns `{ data: [] }` when the resolved version is `< 1`.
  - `export interface SkillFile { fileName: string; size: number }` in `apps/web/components/platform/skills/types.ts`.
  - `export async function listSkillFiles(skillId: string): Promise<SkillFile[]>` in `actions.ts`.
  - `SkillDetailContent` props gain `files: SkillFile[]`.

- [ ] **Step 1: Write the failing backend test**

Create `products/agent-platform/packages/api/__tests__/skills.files.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillInstalls } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }));

const s3SendMock = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = s3SendMock },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.test/put') }));

const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_1 = 'tenant-1';

function appWithContext(permissionAction = 'read') {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT_1 }, permissions: [{ resource: 'skills', action: permissionAction }] });
    c.set('userId', 'user-1');
    c.set('traceId', 'trace-1');
    await next();
  });
  return app;
}

function mockSkillAndInstall(skillRow: Record<string, unknown>, installRows: Record<string, unknown>[]) {
  dbMock.select.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === skills) return { where: () => ({ limit: async () => [skillRow] }) };
      if (table === skillInstalls) return { where: () => ({ limit: async () => installRows }) };
      throw new Error('unexpected select target');
    },
  }));
}

describe('GET /skills/:id/files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
  });

  it("lists the package files for this tenant's pinned version", async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', isOfficial: false, latestVersion: 3 },
      [{ installedVersion: 2 }],
    );
    s3SendMock.mockResolvedValueOnce({
      Contents: [
        { Key: `skill-packages/${SKILL_ID}/2/scripts/run.py`, Size: 120 },
        { Key: `skill-packages/${SKILL_ID}/2/SKILL.md`, Size: 900 },
      ],
    });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { fileName: 'SKILL.md', size: 900 },
      { fileName: 'scripts/run.py', size: 120 },
    ]);
    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Prefix: `skill-packages/${SKILL_ID}/2/` }) }),
    );
  });

  it('falls back to latestVersion when this tenant has no install', async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false, latestVersion: 5 },
      [],
    );
    s3SendMock.mockResolvedValueOnce({ Contents: [{ Key: `skill-packages/${SKILL_ID}/5/SKILL.md`, Size: 10 }] });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect((await res.json()).data).toEqual([{ fileName: 'SKILL.md', size: 10 }]);
  });

  it("returns 403 for another tenant's private skill", async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false, latestVersion: 1 },
      [],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect(res.status).toBe(403);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it('returns an empty list without touching S3 when no version is ready', async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', isOfficial: false, latestVersion: 0 },
      [],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect((await res.json()).data).toEqual([]);
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.files.test.ts`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Add the endpoint**

In `products/agent-platform/packages/api/routes/skills.ts`, extend the S3 import on line 4:

```ts
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
```

Insert this route immediately after the `GET /skills/:id/versions` handler:

```ts
// GET /skills/:id/files — read-only listing of the package files the import
// worker wrote to skill-packages/{skillId}/{version}/. No package-format change:
// this just enumerates an S3 prefix that already exists. Version resolution
// mirrors the rest of the UI — this tenant's pinned install if there is one,
// otherwise the skill's latest.
skillsRoutes.get('/:id/files', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'skills', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const skillId = c.req.param('id');
  if (!uuidSchema.safeParse(skillId).success) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);

  try {
    const skill = await resolveSkill(skillId);
    if (!skill) return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    const isOwner = skill.ownerTenantId === tenantId;
    if (!isOwner && skill.visibility !== 'public' && !skill.isOfficial) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const [install] = await db
      .select({ installedVersion: skillInstalls.installedVersion })
      .from(skillInstalls)
      .where(and(
        eq(skillInstalls.skillId, skillId),
        eq(skillInstalls.tenantId, tenantId),
        eq(skillInstalls.status, 'active'),
      ))
      .limit(1);

    const version = install?.installedVersion ?? skill.latestVersion;
    // latestVersion only moves once an import reaches 'ready', so 0 means the
    // prefix does not exist yet — skip the S3 round trip entirely.
    if (version < 1) return c.json({ data: [] });

    const prefix = `skill-packages/${skillId}/${version}/`;
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.DOCUMENTS_BUCKET!,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    const data = (listed.Contents ?? [])
      .map((obj) => ({ fileName: (obj.Key ?? '').slice(prefix.length), size: obj.Size ?? 0 }))
      .filter((f) => f.fileName.length > 0)
      .sort((a, b) => a.fileName.localeCompare(b.fileName));

    return c.json({ data });
  } catch (err) {
    console.error('Failed to list skill files:', err);
    return c.json(INTERNAL_ERROR, 500);
  }
});
```

- [ ] **Step 4: Run the backend test to verify it passes**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/skills.files.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing web test**

In `apps/web/components/platform/skills/SkillDetailContent.test.tsx`, every existing `render(<SkillDetailContent ... />)` call must now pass `files={[]}`. Add that prop to each of the four existing renders, then append:

```tsx
describe("SkillDetailContent files sidebar", () => {
    it("lists every file in the package", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ body: "# PDF Tools" })}
                isOwner
                files={[
                    { fileName: "SKILL.md", size: 900 },
                    { fileName: "scripts/run.py", size: 120 },
                ]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("SKILL.md")).toBeTruthy();
        expect(screen.getByText("scripts/run.py")).toBeTruthy();
    });

    it("says so when the package has no listed files", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ body: "# PDF Tools" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("No files")).toBeTruthy();
    });
});
```

- [ ] **Step 6: Run the web test to verify it fails**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills/SkillDetailContent.test.tsx`
Expected: FAIL — the hardcoded "Skill.md" row renders and `scripts/run.py` is not found.

- [ ] **Step 7: Add the web type, action, and rendering**

In `apps/web/components/platform/skills/types.ts`, append:

```ts
/** One file inside a skill package, from GET /skills/:id/files. Read-only listing. */
export interface SkillFile {
    fileName: string;
    size: number;
}
```

In `apps/web/components/platform/skills/actions.ts`, change the type import to:

```ts
import type { Skill, SkillFile, SkillTab, SkillsResponse } from "./types";
```

and append:

```ts
export async function listSkillFiles(skillId: string): Promise<SkillFile[]> {
    const res = await api.get<{ data: SkillFile[] }>(`/api/v1/skills/${skillId}/files`);
    return res.data;
}
```

In `apps/web/components/platform/skills/SkillDetailContent.tsx`, change the type import to:

```tsx
import type { Skill, SkillFile } from "./types";
```

Change the component signature to accept and forward `files`:

```tsx
export function SkillDetailContent({
    skill, isOwner, files, onInstall, onUninstall, onPublish,
}: {
    skill: Skill;
    isOwner: boolean;
    files: SkillFile[];
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
}) {
```

Change the `SkillOverview` usage (currently `<SkillOverview skill={skill} />`) to:

```tsx
            <SkillOverview skill={skill} files={files} />
```

Change the `SkillOverview` signature to:

```tsx
function SkillOverview({ skill, files }: { skill: Skill; files: SkillFile[] }) {
```

and replace the hardcoded Files block in its sidebar with:

```tsx
                <div className="mt-3 space-y-1.5">
                    <h5 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Files</h5>
                    {files.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No files</p>
                    ) : (
                        files.map((file) => (
                            <div key={file.fileName} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground">
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate" title={file.fileName}>{file.fileName}</span>
                            </div>
                        ))
                    )}
                </div>
```

In `apps/web/components/platform/skills/SkillDetailModal.tsx`, extend the actions import:

```tsx
import { getSkill, installSkill, listSkillFiles, publishSkill, uninstallSkill } from "./actions";
```

and the type import:

```tsx
import type { Skill, SkillFile } from "./types";
```

Add this query immediately after the existing `useQuery<Skill>` block:

```tsx
    // Only fetched once an import has produced a package to list — a pending or
    // failed version has no S3 prefix, so the request would always come back empty.
    const { data: files } = useQuery<SkillFile[]>({
        queryKey: ["skills", "files", skillId],
        queryFn: () => listSkillFiles(skillId as string),
        enabled: skillId !== null && skill?.latestVersionStatus === "ready",
    });
```

and pass it into the content component:

```tsx
                        <SkillDetailContent
                            skill={skill}
                            isOwner={skill.ownerTenantId === tenantId}
                            files={files ?? []}
                            onInstall={handleInstall}
                            onUninstall={handleUninstall}
                            onPublish={handlePublish}
                        />
```

- [ ] **Step 8: Run the web tests to verify they pass**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills`
Expected: PASS.

- [ ] **Step 9: Type-check and commit**

```bash
pnpm --filter @serverless-saas/agent-api run type-check
pnpm --filter @serverless-saas/web run type-check
git add products/agent-platform/packages/api/routes/skills.ts \
  products/agent-platform/packages/api/__tests__/skills.files.test.ts \
  apps/web/components/platform/skills/types.ts \
  apps/web/components/platform/skills/actions.ts \
  apps/web/components/platform/skills/SkillDetailContent.tsx \
  apps/web/components/platform/skills/SkillDetailContent.test.tsx \
  apps/web/components/platform/skills/SkillDetailModal.tsx
git commit -m "feat(skills): real package file listing from S3"
```

---

## Task 8: Test in chat (Phase E)

**Files:**
- Modify: `apps/web/components/platform/skills/actions.ts`
- Modify: `apps/web/components/platform/skills/actions.test.ts`
- Modify: `apps/web/components/platform/skills/SkillDetailContent.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailContent.test.tsx`
- Modify: `apps/web/components/platform/skills/SkillDetailModal.tsx`

**Interfaces:**
- Consumes: `attachSkillToAgent(agentId: string, skill: Skill): Promise<void>` from Task 3; `Agent` from `@/components/platform/agents/types`.
- Produces:
  - `export function resolveDefaultAgent(agents: Agent[]): Agent | null` — the exact `activeAgents.find(a => a.isDefault) ?? activeAgents[0]` fallback used by `useChatPage.ts`.
  - `export async function startSkillTestChat(skill: Skill, agents: Agent[]): Promise<{ conversationId: string; agentId: string }>` — throws `new Error("NO_ACTIVE_AGENTS")` when there is no active agent.
  - `SkillDetailContent` props gain `onTest: () => void` and `isTesting: boolean`.

- [ ] **Step 1: Write the failing action tests**

Append to `apps/web/components/platform/skills/actions.test.ts`:

```ts
import { resolveDefaultAgent, startSkillTestChat } from "./actions";
import type { Agent } from "@/components/platform/agents/types";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
        id: "agent-1",
        tenantId: "tenant-1",
        name: "Research Engineer",
        type: "custom",
        status: "active",
        model: null,
        llmProviderId: null,
        isInternal: false,
        isDefault: false,
        description: null,
        persona: null,
        avatarUrl: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("resolveDefaultAgent", () => {
    it("prefers the isDefault agent among active agents", () => {
        const flagged = makeAgent({ id: "agent-2", isDefault: true });
        expect(resolveDefaultAgent([makeAgent(), flagged])?.id).toBe("agent-2");
    });

    it("falls back to the first active agent when none is flagged", () => {
        expect(resolveDefaultAgent([makeAgent(), makeAgent({ id: "agent-2" })])?.id).toBe("agent-1");
    });

    it("ignores non-active agents", () => {
        expect(resolveDefaultAgent([makeAgent({ status: "retired", isDefault: true }), makeAgent({ id: "agent-2" })])?.id).toBe("agent-2");
    });

    it("returns null when there is no active agent", () => {
        expect(resolveDefaultAgent([makeAgent({ status: "paused" })])).toBeNull();
    });
});

describe("startSkillTestChat", () => {
    beforeEach(() => vi.clearAllMocks());

    it("creates a conversation with the default agent then attaches the skill", async () => {
        vi.mocked(api.post)
            .mockResolvedValueOnce({ data: { id: "conv-1" } })
            .mockResolvedValueOnce({});

        const result = await startSkillTestChat(makeSkill(), [makeAgent()]);

        expect(result).toEqual({ conversationId: "conv-1", agentId: "agent-1" });
        expect(api.post).toHaveBeenNthCalledWith(1, "/api/v1/conversations", { agentId: "agent-1" });
        expect(api.post).toHaveBeenNthCalledWith(2, "/api/v1/agents/agent-1/skills", {
            name: "PDF Tools",
            installId: "11111111-1111-4111-8111-111111111111",
        });
    });

    it("throws NO_ACTIVE_AGENTS without creating a conversation", async () => {
        await expect(startSkillTestChat(makeSkill(), [])).rejects.toThrow("NO_ACTIVE_AGENTS");
        expect(api.post).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills/actions.test.ts`
Expected: FAIL — `resolveDefaultAgent` / `startSkillTestChat` are not exported.

- [ ] **Step 3: Implement the actions**

In `apps/web/components/platform/skills/actions.ts`, add the Agent type import at the top:

```ts
import type { Agent } from "@/components/platform/agents/types";
```

and append:

```ts
/**
 * Deliberately identical to useChatPage.ts's New Chat fallback:
 * `activeAgents.find(a => a.isDefault) ?? activeAgents[0]`. agents.isDefault is
 * effectively a dead column (never written), so in practice this resolves to
 * the earliest-created active agent. Reused rather than replaced so Test-in-chat
 * lands the user on the same agent New Chat would.
 */
export function resolveDefaultAgent(agents: Agent[]): Agent | null {
    const active = agents.filter((a) => a.status === "active");
    return active.find((a) => a.isDefault) ?? active[0] ?? null;
}

/**
 * Opens a fresh conversation on the tenant's default agent with this skill
 * attached. The attach carries the real SKILL.md body (derived server-side), so
 * the agent's behavior in that conversation genuinely reflects the skill.
 * Throws Error("NO_ACTIVE_AGENTS") when the tenant has none.
 */
export async function startSkillTestChat(
    skill: Skill,
    agents: Agent[],
): Promise<{ conversationId: string; agentId: string }> {
    const agent = resolveDefaultAgent(agents);
    if (!agent) throw new Error("NO_ACTIVE_AGENTS");

    const conversation = await api.post<{ data: { id: string } }>("/api/v1/conversations", { agentId: agent.id });
    await attachSkillToAgent(agent.id, skill);
    return { conversationId: conversation.data.id, agentId: agent.id };
}
```

- [ ] **Step 4: Run the action test to verify it passes**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Append to `apps/web/components/platform/skills/SkillDetailContent.test.tsx`:

```tsx
describe("SkillDetailContent test button", () => {
    it("offers Test alongside Uninstall for an installed skill", async () => {
        const onTest = vi.fn();
        render(
            <SkillDetailContent
                skill={makeSkill({ installed: true, installedVersion: 2, installId: "install-1" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={onTest}
                isTesting={false}
            />,
        );

        const button = screen.getByRole("button", { name: "Test in chat" });
        button.click();
        expect(onTest).toHaveBeenCalledTimes(1);
    });

    it("hides Test when the skill is not installed", () => {
        render(
            <SkillDetailContent
                skill={makeSkill()}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={vi.fn()}
                isTesting={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Test in chat" })).toBeNull();
    });
});
```

Also add `onTest={noop}` and `isTesting={false}` to every pre-existing `render(<SkillDetailContent ... />)` call in this file.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @serverless-saas/web exec vitest run components/platform/skills/SkillDetailContent.test.tsx`
Expected: FAIL — no button named "Test in chat".

- [ ] **Step 7: Add the Test button and modal handler**

In `apps/web/components/platform/skills/SkillDetailContent.tsx`, extend the props:

```tsx
export function SkillDetailContent({
    skill, isOwner, files, onInstall, onUninstall, onPublish, onTest, isTesting,
}: {
    skill: Skill;
    isOwner: boolean;
    files: SkillFile[];
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
    onTest: () => void;
    isTesting: boolean;
}) {
```

Replace the installed branch of the header action block:

```tsx
                    <div className="flex shrink-0 items-center gap-2">
                        {skill.installed ? (
                            <>
                                <Button onClick={onTest} disabled={isTesting}>
                                    {isTesting ? "Opening chat…" : "Test in chat"}
                                </Button>
                                <Button variant="outline" onClick={onUninstall}>Uninstall</Button>
                            </>
                        ) : dead ? null : (
                            <Button onClick={onInstall} disabled={importing}>
                                <Plus className="h-4 w-4" />
                                {importing ? "Importing…" : "Install skill"}
                            </Button>
                        )}
                    </div>
```

In `apps/web/components/platform/skills/SkillDetailModal.tsx`, extend the imports:

```tsx
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { getSkill, installSkill, listSkillFiles, publishSkill, startSkillTestChat, uninstallSkill } from "./actions";
import type { Agent } from "@/components/platform/agents/types";
```

Inside the component, after `const [expanded, setExpanded] = useState(false);` add:

```tsx
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const [isTesting, setIsTesting] = useState(false);

    // Same ['agents'] query key the chat page uses, so this shares its cache
    // rather than issuing a second fetch.
    const { data: agentsData } = useQuery<{ data: Agent[] }>({
        queryKey: ["agents"],
        queryFn: () => api.get("/api/v1/agents"),
        enabled: skillId !== null,
    });
```

Add the handler next to `handlePublish`:

```tsx
    const handleTest = async () => {
        if (!skill) return;
        setIsTesting(true);
        try {
            const { conversationId } = await startSkillTestChat(skill, agentsData?.data ?? []);
            onOpenChange(false);
            router.push(`/${tenantSlug}/dashboard/chat?conversationId=${conversationId}`);
        } catch (err) {
            if (err instanceof Error && err.message === "NO_ACTIVE_AGENTS") {
                toast.error("No active agents available. Please create one first.");
            } else if (err instanceof Error && err.message === "NO_INSTALL_ID") {
                toast.error("This skill has no install record — reinstall it from the Skills page first.");
            } else {
                toast.error("Failed to start a test chat.");
            }
        } finally {
            setIsTesting(false);
        }
    };
```

Pass the new props to the content component:

```tsx
                            onPublish={handlePublish}
                            onTest={handleTest}
                            isTesting={isTesting}
```

- [ ] **Step 8: Run the full web and API suites**

Run: `pnpm --filter @serverless-saas/web exec vitest run && pnpm --filter @serverless-saas/agent-api exec vitest run && pnpm --filter agent-orchestrator exec vitest run`
Expected: PASS across all three.

- [ ] **Step 9: Manually verify in the running app**

Per `CLAUDE.md`, Phase E is verified by hand:

```bash
cd apps/api && pnpm dev          # terminal 1
cd apps/web && pnpm dev          # terminal 2
cd apps/agent-orchestrator && pnpm dev   # terminal 3
```

Then in the browser: Skills page → open an installed skill's detail modal → click **Test in chat** → confirm a new conversation opens at `/{tenant}/dashboard/chat`, that the attached skill appears on the agent, and that the agent's reply reflects the SKILL.md content (not just the one-line description). Then re-open the skill modal and confirm **Runs** has incremented.

- [ ] **Step 10: Type-check and commit**

```bash
pnpm --filter @serverless-saas/web run type-check
git add apps/web/components/platform/skills/actions.ts \
  apps/web/components/platform/skills/actions.test.ts \
  apps/web/components/platform/skills/SkillDetailContent.tsx \
  apps/web/components/platform/skills/SkillDetailContent.test.tsx \
  apps/web/components/platform/skills/SkillDetailModal.tsx
git commit -m "feat(skills): test a skill in a fresh chat on the default agent"
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| Phase A — owner info on `/skills` + `/skills/:id` | Task 1 |
| Phase A — Author row renders real value | Task 2 (Step 6) |
| Phase A — fake `<span>` becomes real `<button>` calling `installSkill`, with `stopPropagation` | Task 2 (Steps 2, 5, 7) |
| Phase B — server derives `system_prompt` from the manifest body | Task 3 |
| Phase B — client stops sending `systemPrompt` | Task 3 (Step 7) |
| Phase B — no downstream change needed | Confirmed: `chatStream.ts`/`platformAgent.ts` untouched by Task 3 |
| Phase C — `skills.download_count`, incremented in `POST /skills/:id/install` | Task 4 |
| Phase C — `skill_installs.run_count`, incremented at the `fetchAgentSkill` call site | Task 5 |
| Phase C — `runCount`/`downloadCount` on `GET /skills` and `/skills/:id` | Tasks 4 & 5 |
| Phase C — card + modal swap both `—` placeholders | Task 6 |
| Phase D — `GET /skills/:id/files` via `ListObjectsV2` returning `[{ fileName, size }]` | Task 7 |
| Phase D — sidebar renders the real list | Task 7 (Step 7) |
| Phase E — Test button shown when installed | Task 8 |
| Phase E — create conversation → attach → navigate to `?conversationId=` | Task 8 (`startSkillTestChat` + `handleTest`) |
| Phase E — reuse `useChatPage`'s default-agent fallback and its zero-agent error copy | Task 8 (`resolveDefaultAgent`, `handleTest` catch) |
| Spec Testing section — component tests (A/D), integration tests (B/C), manual verification (E) | Tasks 2, 3, 4, 5, 6, 7, 8 (Step 9) |

No gaps. Dependency order holds: Phase B (Task 3) precedes Phase E (Task 8), which reuses `attachSkillToAgent`.

**2. Placeholder scan**

No "TBD", "similar to Task N", "add appropriate error handling", or "write tests for the above". Every code step carries literal code. The two deliberate temporary values — the `— runs` / `—` strings left in `SkillCard.tsx` at the end of Task 2 — are called out inline as replaced by Task 6, and Task 6 shows the full replacement block rather than a diff fragment.

**3. Type consistency**

- `ownerName: string | null` / `ownerEmail: string | null` — defined in Task 1 (API), mirrored in Task 2 (`types.ts`), consumed in Task 2 Step 6. Same names, same nullability.
- `downloadCount: number` — Task 4 (API + Drizzle `downloadCount`/`download_count`), Task 6 (`types.ts` + `SkillCard`). Not `downloads`.
- `runCount: number` — Task 5 (API + Drizzle `runCount`/`run_count`), Task 6 (`types.ts` + `SkillCard` + `SkillDetailContent`). Never null in the response (`?? 0` applied server-side), so the web type is non-optional `number`, matching the test fixtures in Tasks 2, 3, 6.
- `SkillFile { fileName: string; size: number }` — one definition (Task 7), used identically by the API response, `listSkillFiles`, `SkillDetailContent`, and `SkillDetailModal`.
- `attachSkillToAgent(agentId: string, skill: Skill): Promise<void>` — defined Task 3, consumed unchanged by `AttachSkillPicker` (Task 3) and `startSkillTestChat` (Task 8).
- `recordSkillRun(installId: string, tenantId: string): Promise<void>` — defined and consumed within Task 5 only.
- `SkillCardProps` gains `onInstall: () => void` in Task 2; `page.tsx`'s `SkillGrid` uses `onInstall: (skillId: string) => void` and adapts with `onInstall={() => onInstall(skill.id)}` — intentional, and both signatures appear in Task 2 Step 7.
- `SkillDetailContent` props grow monotonically: `files` added in Task 7, `onTest`/`isTesting` in Task 8; each task's step explicitly instructs updating the pre-existing test renders so the file always type-checks.
