# Agent Skills Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `agent_skills` one job, attached skills, by moving the agent's base prompt to `agents.system_prompt`, keying attached skills on their install, and making `/` turn a skill on for one conversation through Mastra's native `skill` tool.

**Architecture:** Two pull requests, because today's orchestrator reads the `default` rows. PR 1 (Tasks 1–11) adds the new column and indexes, copies the prompts, and ships all new code with transition guards that ignore any `default` row still present. PR 2 (Tasks 12–13) deletes the `default` rows, swaps the last constraint, and removes the guards. It merges only after PR 1 is deployed everywhere.

**Tech Stack:** TypeScript, `@mastra/core@1.64.0`, drizzle-orm 0.45.2, drizzle-kit 0.28, Hono (API Lambda), SQS worker Lambda, Next.js + TanStack Query (web), vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-agent-skills-model-design.md`

## Global Constraints

- `@mastra/core@1.64.0` exactly. Load invoked skills with Mastra's own `skill` tool, forced by the per-call `prepareStep` option. Never paste a skill's instructions into the prompt by hand.
- Orchestrator code is ESM: every relative import ends in `.js`.
- Every new query filters by the tenant id from the verified token. A client-sent skill id is never trusted: resolve it to this tenant's own active install, and drop anything that doesn't match.
- An agent keeps at most 8 attached skills. A conversation keeps at most 8 invoked skills.
- Remove the 24,000-character budget (`MAX_COMPOSED_SKILL_CHARS`) everywhere. Keep the 8-skill cap.
- `/` never attaches a skill to an agent. In a Test-in-chat conversation, `/` does not open the picker. The hint text there is exactly: `Test chats run one skill. Start a normal chat to combine skills.`
- Tests run with no database and no model call. Test commands:
  - `pnpm --filter agent-orchestrator test`
  - `pnpm --filter @serverless-saas/agent-api test`
  - `pnpm --filter @serverless-saas/agent-worker-handlers test`
  - `pnpm --filter @serverless-saas/api test`
  - `pnpm --filter @serverless-saas/web test`
- Two orchestrator test files already fail on `main` and are not yours to fix: `src/mastra/__tests__/serverTools.test.ts` and `src/__tests__/tasks-execute.test.ts`. Any other failure is yours.
- Generate schema migrations with `pnpm --filter @serverless-saas/database db:generate`. Never hand-set a journal `when`. `0084` has a hand-set one, and drizzle skips anything older than the latest recorded migration.
- Do not run `drizzle-kit migrate` against any database. Applying migrations belongs to the rollout checklist at the end, and needs the user.
- Commit by explicit path only. Never `git add -A`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Rollout order (for whoever deploys; not a task)

1. Merge PR 1. Apply its migration (`0091`) to dev. It is additive and safe while old code runs.
2. Rebuild `packages/foundation/*` and `products/agent-platform/packages/*` `dist/`, then deploy:
   - the API and worker Lambdas (`sam build` + `sam deploy`);
   - the web app (`./deploy.sh`);
   - the orchestrator (`git pull` + `pm2 restart agent-orchestrator` on the VM).
3. Check the PR 1 "done" items on dev.
4. Merge PR 2. Apply its migration (`0092`). Deploy the orchestrator, API and worker again.

## File structure

| File | Change | Task |
|---|---|---|
| `products/agent-platform/packages/schema/agents.ts` | Add `agents.systemPrompt` | 1 |
| `products/agent-platform/packages/schema/conversations.ts` | Add an active-install unique index on `agentSkills` (T1). Swap the name/version unique for a hand-authored partial index (T12) | 1, 12 |
| `packages/foundation/database/migrations/0091_*.sql` | Generated, plus hand-added copy and archive statements | 1 |
| `apps/agent-orchestrator/src/usage.ts` | `fetchAgentPersonaPrompt` reads the column (T2). `resolveInvokedSkills` (T8). `fetchInvokedSkills` (T9). Guard removal (T13) | 2, 8, 9, 13 |
| `apps/api/src/routes/onboarding.ts`, `packages/foundation/database/seeds/backfill-agents.ts` | Write `agents.systemPrompt`; stop inserting `default` rows | 3 |
| `products/agent-platform/packages/api/routes/agent-skills.ts` | Attach by install, reactivate on re-attach, server-derived name, no char budget, list filter | 4, 13 |
| `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts` | Attach by install, reactivate, no char budget | 5, 13 |
| `apps/api/src/routes/integrations.sync.ts` and its 4 caller files | Delete the dead tool-allowlist sync | 6 |
| `apps/agent-orchestrator/src/mastra/tools/createSkill.ts` | Drop the char budget | 6 |
| `products/agent-platform/packages/api/routes/agents.fairness.ts`, `ops.fairness.ts` | Read the prompt from `agents` | 6 |
| `products/agent-platform/packages/api/routes/conversations.ts` | PATCH `invokedSkills` | 7 |
| `apps/agent-orchestrator/src/persistence.ts` | `fetchConversationSkillSettings`, `saveConversationInvokedSkills` | 8 |
| `apps/agent-orchestrator/src/mastra/context.ts` | `invokedSkillInstallIds`, `skillsInvokedThisTurn` | 8 |
| `apps/agent-orchestrator/src/routes/chatStream.ts` | Resolve and persist invoked skills, pass `prepareStep` | 8, 9 |
| `apps/agent-orchestrator/src/mastra/skillInvocation.ts` (new) | `buildSkillInvocationPrepareStep` | 9 |
| `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` | Resolver merges invoked skills; instruction line | 9 |
| `apps/web/components/platform/chat/ChatInput.tsx`, `SkillChip.tsx`, `types.ts`, `app/[tenant]/dashboard/chat/page.tsx` | Conversation chips, no attach, `/` off in test chats | 10 |
| `apps/web/components/platform/skills/actions.ts`, `app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection.tsx` | Attached-skill list and detach | 11 |
| `packages/foundation/database/migrations/0092_*.sql` | Generated, plus hand-added cleanup statements | 12 |

---

## PR 1

### Task 1: `agents.system_prompt`, the active-install index, and Migration A

**Files:**
- Modify: `products/agent-platform/packages/schema/agents.ts:50` (the `agents` table)
- Modify: `products/agent-platform/packages/schema/conversations.ts:97-112` (`agentSkills`)
- Create: `packages/foundation/database/migrations/0091_<generated-name>.sql`, plus its `meta/0091_snapshot.json` and the `meta/_journal.json` entry (all generated)

**Interfaces:**
- Produces:
  - `agents.systemPrompt: text | null`. Later tasks read and write it.
  - the unique index `agent_skills_agent_install_active_unique` on `(agent_id, install_id)` where `install_id is not null and status = 'active'`. Tasks 4 and 5 rely on it, and on its exact name.

- [ ] **Step 1: Add the column**

In `products/agent-platform/packages/schema/agents.ts`, after `description: text('description'),` (line 50), add:

```ts
  // The agent's base prompt. Null means "use the platform prompt"
  // (agent_templates, via fetchPlatformPrompt). Replaces the 'default'
  // agent_skills row that used to carry it — see
  // docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
  systemPrompt: text('system_prompt'),
```

- [ ] **Step 2: Add the active-install unique index**

In `products/agent-platform/packages/schema/conversations.ts`:
- Add `uniqueIndex` to the `drizzle-orm/pg-core` import, and `sql` to the `drizzle-orm` import (add either import if it's missing).
- Replace the `agentSkills` table's third argument (lines 110-112) with:

```ts
}, (t) => ({
  uniqueSkillVersion: unique().on(t.agentId, t.tenantId, t.name, t.version),
  // An installed skill is identified by its install, not its free-text name:
  // two writers used to name the same install differently and both rows got
  // in. Active rows only, so a detached (archived) row never blocks a
  // re-attach. Tasks 4 and 5 reactivate the existing row instead of inserting.
  activeInstallUnique: uniqueIndex('agent_skills_agent_install_active_unique')
    .on(t.agentId, t.installId)
    .where(sql`install_id is not null and status = 'active'`),
}));
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @serverless-saas/database db:generate`

Expected: a new `packages/foundation/database/migrations/0091_*.sql` containing exactly two statements:
- `ALTER TABLE "agents" ADD COLUMN "system_prompt" text;`
- `CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_agent_install_active_unique" ON "agent_skills" ... WHERE install_id is not null and status = 'active';`

If the file contains anything else, stop and report it. It means drizzle picked up schema drift from someone else's uncommitted work.

- [ ] **Step 4: Add the data statements, in the right places**

Edit the generated file. Order matters: the copy must follow the `ADD COLUMN`, and the archive must precede the `CREATE UNIQUE INDEX`. The index cannot be created while dev still holds a duplicate active install (Olmo in `yash-test`).

Directly after the `ALTER TABLE "agents" ADD COLUMN ...;` line, insert:

```sql
--> statement-breakpoint
-- Copy each agent's base prompt off its 'default' agent_skills row. Latest
-- active row wins, matching fetchAgentPersonaPrompt's old ORDER BY
-- created_at DESC LIMIT 1. The 'default' rows stay until migration 0092,
-- because the code running while this applies still reads them.
UPDATE "agents" a SET "system_prompt" = s."system_prompt"
FROM (
  SELECT DISTINCT ON (agent_id) agent_id, system_prompt
  FROM "agent_skills"
  WHERE name = 'default' AND status = 'active'
  ORDER BY agent_id, created_at DESC
) s
WHERE s.agent_id = a.id AND a.system_prompt IS NULL;
```

Directly before the `CREATE UNIQUE INDEX` line, insert:

```sql
-- Archive duplicate active attachments of the same install, keeping the
-- earliest. Dev has one: Olmo in yash-test holds install 006d2a14 twice.
UPDATE "agent_skills" SET "status" = 'archived', "updated_at" = now()
WHERE "id" IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY agent_id, install_id ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM "agent_skills"
    WHERE install_id IS NOT NULL AND status = 'active'
  ) d
  WHERE d.rn > 1
);
--> statement-breakpoint
```

- [ ] **Step 5: Type-check the schema consumers**

Run: `pnpm --filter @serverless-saas/agent-schema build && pnpm --filter @serverless-saas/agent-api exec tsc --noEmit && pnpm --filter agent-orchestrator type-check`

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/schema/agents.ts \
        products/agent-platform/packages/schema/conversations.ts \
        packages/foundation/database/migrations
git commit -m "feat(schema): agents.system_prompt and an active-install unique index on agent_skills

Migration 0091 copies each agent's base prompt off its 'default' row and
archives duplicate active attachments of one install before adding the index.
Additive: the 'default' rows stay until 0092.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The orchestrator reads the base prompt from `agents`

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts:189-213` (`fetchAgentPersonaPrompt`)
- Test: `apps/agent-orchestrator/src/usage.test.ts`

**Interfaces:**
- Consumes: `agents.system_prompt` (Task 1).
- Produces: `fetchAgentPersonaPrompt(agentId: string, tenantId: string): Promise<string | null>`, with an unchanged signature, so its callers in `chatStream.ts` and `mastra/agent.ts` don't change.

- [ ] **Step 1: Write the failing tests**

In `apps/agent-orchestrator/src/usage.test.ts`:
- Add `fetchAgentPersonaPrompt` to the import from `./usage.js` (line 9).
- Add this block after the `fetchAgentMemory` describe:

```ts
describe('fetchAgentPersonaPrompt', () => {
  it('reads the base prompt from agents.system_prompt, trimmed', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ system_prompt: '  You are Olmo.  ' }] })
    await expect(fetchAgentPersonaPrompt('agent-1', 'tenant-1')).resolves.toBe('You are Olmo.')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('FROM agents')
    expect(sql).not.toContain('agent_skills')
    expect(params).toEqual(['agent-1', 'tenant-1'])
  })

  it('scopes the lookup to the tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAgentPersonaPrompt('agent-1', 'tenant-1')
    expect(mockPoolQuery.mock.calls[0][0]).toContain('tenant_id = $2')
  })

  it('returns null when the agent has no prompt, so the platform prompt applies', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ system_prompt: null }] })
    await expect(fetchAgentPersonaPrompt('agent-1', 'tenant-1')).resolves.toBeNull()
  })

  it('returns null when the prompt is only whitespace', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ system_prompt: '   ' }] })
    await expect(fetchAgentPersonaPrompt('agent-1', 'tenant-1')).resolves.toBeNull()
  })

  it('returns null instead of throwing on a database error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'))
    await expect(fetchAgentPersonaPrompt('agent-1', 'tenant-1')).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator test usage.test`
Expected: the first test FAILS, because the SQL still reads `agent_skills`.

- [ ] **Step 3: Rewrite the function**

Replace `fetchAgentPersonaPrompt` and its doc comment in `apps/agent-orchestrator/src/usage.ts` with:

```ts
/**
 * The agent's base prompt, from agents.system_prompt. Null means the
 * agent uses the platform prompt (platformAgent's fetchPlatformPrompt).
 * Used by chatStream.ts and mastra/agent.ts as the agentSystemPrompt
 * override. It used to live on a 'default' agent_skills row; see
 * docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
 */
export async function fetchAgentPersonaPrompt(agentId: string, tenantId: string): Promise<string | null> {
  const p = getPool()
  try {
    const res = await p.query<{ system_prompt: string | null }>(
      `SELECT system_prompt FROM agents
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [agentId, tenantId],
    )
    const body = res.rows[0]?.system_prompt?.trim()
    return body || null
  } catch (err) {
    console.error('[usage] fetchAgentPersonaPrompt error:', (err as Error).message)
    return null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter agent-orchestrator test usage.test`
Expected: PASS, including the 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts
git commit -m "feat(orchestrator): read the agent base prompt from agents.system_prompt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Onboarding and the backfill script write `agents.system_prompt`

**Files:**
- Modify: `apps/api/src/routes/onboarding.ts`, which has nine agent seeds (table below)
- Modify: `packages/foundation/database/seeds/backfill-agents.ts:193-212`

**Interfaces:**
- Consumes: `agents.systemPrompt` (Task 1).
- Produces: new agents carry their base prompt on the agent row, and no `default` row is written.

**Why there is no unit test in this task:** onboarding has no unit harness. Its only test, `onboarding.credits.test.ts`, is a real-database integration test, skipped unless `TEST_DATABASE_URL` is set, and it isolates the credit grant rather than agent seeding. This task is verified by the exact `grep` checks and type-checks in Step 4, and by a fresh onboarding on dev in the rollout checklist.

- [ ] **Step 1: Move each prompt onto its agent row**

For each row of this table, in `apps/api/src/routes/onboarding.ts`:
- move the `systemPrompt:` property, value unchanged, out of the `db.insert(agentSkills).values({...})` call and into the `db.insert(agents).values({...})` call above it;
- then delete the whole `await db.insert(agentSkills).values({...});` statement.

| Agent variable | `insert(agents)` at | `insert(agentSkills)` at | The `systemPrompt` value to move |
|---|---|---|---|
| `researchAgent` | 189 | 201 | `resolvedSystemPrompt` |
| `olmoAgentRow` | 224 | 236 | the `withUploadGuidance(\`You are Olmo, this workspace's default AI assistant. ...\`)` expression, lines 244-252 |
| `pmAgent` | 269 | 278 | `withUploadGuidance('You are the Product Manager. ...')` |
| `prdAgent` | 304 | 314 | `withUploadGuidance('You are the Analyst. ...')` |
| `roadmapAgent` | 340 | 350 | `withUploadGuidance('You are the Project Manager. ...')` |
| `taskAgentRow` | 376 | 386 | `withUploadGuidance('You are the Tech Lead. ...')` |
| `archAgent` | 412 | 422 | `withUploadGuidance('You are the Architect. ...')` |
| `directorAgentRow` | 448 | 462 | `'You are Director. Generate and edit images from a description.'` |
| `producerAgentRow` | 488 | 498 | `'You are Producer. Generate instrumental music from a description.'` |

For `olmoAgentRow`, the four-line comment above its `systemPrompt` (lines 240-243) moves too. Reword it to:

```ts
        // Olmo's identity + routing prompt, stored on the agent row.
        // chatStream.ts's agentSystemPrompt override replaces the
        // agent_templates prompt outright, so a template change never reaches
        // an agent that has its own prompt here.
```

Line numbers are from `main` at the start of this plan. Each `insert(agentSkills)` call sits directly below its agent's `insert(agents)` call.

- [ ] **Step 2: Remove the dead tool allowlist from onboarding**

In `apps/api/src/routes/onboarding.ts`:
- Delete `const resolvedTools = publishedTemplate?.tools ?? [];` (line 156). Nothing reads `agent_skills.tools` at runtime: both runtime paths pass `enabledTools: null`, per `tasks.execution.ts:79`.
- If the `publishedTemplate` select above it lists a `tools:` field, delete that entry too.
- Remove `agentSkills` from its import, since nothing in the file uses it any more.

- [ ] **Step 3: Same change in the backfill script**

In `packages/foundation/database/seeds/backfill-agents.ts`:
- Add `systemPrompt: def.systemPrompt,` to the `db.insert(agents).values({...})` call (it starts at line 193).
- Delete the `await db.insert(agentSkills).values({...});` statement below it (lines 204-211).
- Remove `agentSkills` from the imports if nothing else uses it.

- [ ] **Step 4: Verify**

```bash
grep -n "agentSkills\|name: 'default'" apps/api/src/routes/onboarding.ts packages/foundation/database/seeds/backfill-agents.ts
```
Expected: no output.

```bash
grep -c "systemPrompt: \(resolvedSystemPrompt\|withUploadGuidance\|'You are \)" apps/api/src/routes/onboarding.ts
```
Expected: `9`.

```bash
pnpm --filter @serverless-saas/api exec tsc --noEmit
pnpm --filter @serverless-saas/database exec tsc --noEmit
```
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/onboarding.ts packages/foundation/database/seeds/backfill-agents.ts
git commit -m "feat(onboarding): store each seeded agent's base prompt on the agent row

No more 'default' agent_skills row, and no dead tool allowlist.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The attach route keys on the install and reactivates on re-attach

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agent-skills.ts`: the constants (lines 14-19), `resolveInstalledSkillBody` (lines 57-68), GET (lines 71-100), POST (lines 102-259)
- Test: `products/agent-platform/packages/api/__tests__/agent-skills.test.ts`, which is rewritten in full

**Interfaces:**
- Consumes: the `agent_skills_agent_install_active_unique` index (Task 1).
- Produces, for Task 11 and the web app:
  - `POST /agents/:agentId/skills` with an `installId`:
    - `201` when a new row is inserted;
    - `200` when the agent's existing row for that install (active or archived) is reactivated;
    - `409 { code: 'CONFLICT' }` when a concurrent attach of the same install won;
    - `409 { code: 'NAME_CONFLICT' }` when a different skill already uses that name;
    - `409 { code: 'SKILL_BUDGET_EXCEEDED' }` at the cap;
    - `409 { code: 'NOT_READY' }` and `404` as today.
  - The row name for an installed skill is the manifest's `name`, never the client's.
  - `GET /agents/:agentId/skills` never returns a row named `default`.

- [ ] **Step 1: Replace the test file**

Replace the whole of `products/agent-platform/packages/api/__tests__/agent-skills.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

function appWithContext(permissionAction = 'create') {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [{ resource: 'agents', action: permissionAction }] });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

interface DbState {
    /** undefined = a valid active install; null = none for this tenant. */
    install?: Record<string, unknown> | null;
    /** undefined = a ready manifest named bid-writer; null = no row. */
    manifest?: Record<string, unknown> | null;
    manifestStatus?: string;
    /** Active rows the cap counts. */
    active?: Array<{ name: string; installId: string | null }>;
    /** The agent's existing row for this install, active or archived. */
    existing?: Array<{ id: string }>;
    /** GET list result. */
    list?: Array<Record<string, unknown>>;
    insertError?: unknown;
}

function mockDb(state: DbState = {}) {
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
            if (table === skillInstalls) {
                const rows = state.install === undefined
                    ? [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 1 }]
                    : state.install ? [state.install] : [];
                return { where: () => ({ limit: async () => rows }) };
            }
            if (table === skillVersions) {
                const rows = state.manifest === null ? [] : [{
                    manifest: state.manifest ?? { name: 'bid-writer', body: 'Open with the client name.' },
                    status: state.manifestStatus ?? 'ready',
                }];
                return { where: () => ({ limit: async () => rows }) };
            }
            if (table === agentSkills) {
                // Three query shapes on this table: the cap count (awaited on
                // where), the existing-row lookup (where → orderBy → limit) and
                // the GET list (where → orderBy, awaited).
                return {
                    where: () => Object.assign(Promise.resolve(state.active ?? []), {
                        orderBy: () => Object.assign(Promise.resolve(state.list ?? []), {
                            limit: async () => state.existing ?? [],
                        }),
                    }),
                };
            }
            throw new Error('unexpected select target');
        },
    }));
    dbMock.insert.mockImplementation((table: unknown) => ({
        values: (data: Record<string, unknown>) => ({
            returning: async () => {
                if (table !== agentSkills) return [{ id: 'audit-1' }];
                if (state.insertError) throw state.insertError;
                inserted.push(data);
                return [{ id: 'row-new', ...data }];
            },
            catch: () => {},
        }),
    }));
    dbMock.update.mockImplementation(() => ({
        set: (data: Record<string, unknown>) => ({
            where: () => ({
                returning: async () => {
                    updated.push(data);
                    return [{ id: 'row-1', ...data }];
                },
            }),
        }),
    }));
    return { inserted, updated };
}

async function request(method: 'GET' | 'POST', body?: unknown, permission = 'create') {
    const { agentSkillsRoutes } = await import('../routes/agent-skills');
    const app = appWithContext(permission);
    app.route('/agents', agentSkillsRoutes);
    return app.request('/agents/agent-1/skills', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const uniqueViolation = (constraint: string) => ({ cause: { code: '23505', constraint } });

describe('POST /agents/:agentId/skills — installed skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("stores the manifest's name, ignoring the name the client sent", async () => {
        const { inserted } = mockDb();
        const res = await request('POST', { name: 'Bid Writer (display name)', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(inserted[0]).toMatchObject({ name: 'bid-writer', installId: INSTALL_ID, systemPrompt: 'Open with the client name.' });
    });

    it('ignores a client-supplied systemPrompt for an installed skill', async () => {
        const { inserted } = mockDb();
        await request('POST', { name: 'x', installId: INSTALL_ID, systemPrompt: 'injected' });
        expect(inserted[0].systemPrompt).toBe('Open with the client name.');
    });

    it("reactivates the agent's existing row for the install instead of inserting a second", async () => {
        const { inserted, updated } = mockDb({ existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
        expect(inserted).toHaveLength(0);
        expect(updated[0]).toMatchObject({ status: 'active', name: 'bid-writer', systemPrompt: 'Open with the client name.' });
    });

    it("returns 404 for an install that isn't this tenant's active install", async () => {
        mockDb({ install: null });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(404);
    });

    it('returns 409 NOT_READY when the pinned version has no readable body', async () => {
        mockDb({ manifestStatus: 'pending' });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NOT_READY');
    });

    it('rejects a non-uuid installId', async () => {
        mockDb();
        const res = await request('POST', { name: 'x', installId: 'not-a-uuid' });
        expect(res.status).toBe(400);
    });

    it('returns 409 CONFLICT when a concurrent attach of the same install wins the race', async () => {
        mockDb({ insertError: uniqueViolation('agent_skills_agent_install_active_unique') });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('CONFLICT');
    });

    it('returns 409 NAME_CONFLICT when a different skill already uses the name', async () => {
        mockDb({ insertError: uniqueViolation('agent_skills_agent_id_tenant_id_name_version_unique') });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NAME_CONFLICT');
    });

    it('has no character budget: a long skill attaches', async () => {
        const { inserted } = mockDb({ manifest: { name: 'long-skill', body: 'x'.repeat(30_000) } });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(inserted).toHaveLength(1);
    });
});

describe('POST /agents/:agentId/skills — the 8-skill cap', () => {
    beforeEach(() => vi.clearAllMocks());

    const others = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `skill-${i}`, installId: `install-${i}` }));

    it('refuses a ninth skill', async () => {
        mockDb({ active: others(8) });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
    });

    it("does not count the agent's 'default' row, which is its base prompt", async () => {
        mockDb({ active: [{ name: 'default', installId: null }, ...others(7)] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
    });

    it('does not count the install being re-attached against itself', async () => {
        mockDb({ active: [...others(7), { name: 'bid-writer', installId: INSTALL_ID }], existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
    });
});

describe('POST /agents/:agentId/skills — hand-authored skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("creates a hand-authored skill with the client's name and prompt", async () => {
        const { inserted } = mockDb();
        const res = await request('POST', { name: 'Custom Skill', systemPrompt: 'You do X.' });
        expect(res.status).toBe(201);
        expect(inserted[0]).toMatchObject({ name: 'Custom Skill', systemPrompt: 'You do X.', installId: null });
    });

    it('still requires systemPrompt without an installId', async () => {
        mockDb();
        const res = await request('POST', { name: 'Custom Skill' });
        expect(res.status).toBe(400);
    });

    it('rejects without agents:create permission', async () => {
        mockDb();
        const res = await request('POST', { name: 'Custom Skill', systemPrompt: 'You do X.' }, 'read');
        expect(res.status).toBe(403);
    });
});

describe('GET /agents/:agentId/skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("lists attached skills without the agent's 'default' row", async () => {
        mockDb({ list: [{ id: 'a', name: 'default' }, { id: 'b', name: 'bid-writer' }] });
        const res = await request('GET', undefined, 'read');
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual([{ id: 'b', name: 'bid-writer' }]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api test agent-skills`
Expected: FAIL on the manifest-name, reactivate, NAME_CONFLICT, character-budget, `default`-cap and GET tests.

- [ ] **Step 3: Replace the constants**

Replace lines 14-19 (the comment, `MAX_ATTACHED_SKILLS` and `MAX_COMPOSED_SKILL_CHARS`) with:

```ts
// Abuse ceiling, not a prompt budget: native Mastra skills are listed by name
// and description and loaded on demand, so an attached skill no longer costs
// its full body in every prompt. The import worker enforces the same cap.
const MAX_ATTACHED_SKILLS = 8;

// The partial unique index from migration 0091. A 23505 naming it means the
// same install is already attached; any other 23505 is a name collision.
const ACTIVE_INSTALL_UNIQUE = 'agent_skills_agent_install_active_unique';
```

Add `sql` to the `drizzle-orm` import on line 2: `import { and, eq, desc, sql } from 'drizzle-orm';`.

- [ ] **Step 4: Return the manifest's name alongside its body**

Replace `resolveInstalledSkillBody` (lines 57-68, with its comment) with:

```ts
// The *pinned* version's manifest, not the latest: an install is npm-style
// pinned. Only a 'ready' row's manifest was written by a completed import.
// Returns the body the agent runs on and the manifest's own name, which is
// the one name an installed skill's row carries. Two writers used to name the
// same install differently (display name vs manifest name) and both rows got in.
async function resolveInstalledSkillManifest(
    skillId: string,
    version: number,
): Promise<{ body: string; name: string | null } | null> {
    const [row] = await db
        .select({ manifest: skillVersions.manifest, status: skillVersions.status })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
        .limit(1);
    if (!row || row.status !== 'ready' || !row.manifest || typeof row.manifest !== 'object') return null;
    const manifest = row.manifest as Record<string, unknown>;
    const body = typeof manifest.body === 'string' && manifest.body.length > 0 ? manifest.body : null;
    if (!body) return null;
    const name = typeof manifest.name === 'string' && manifest.name.trim().length > 0 ? manifest.name.trim() : null;
    return { body, name };
}
```

- [ ] **Step 5: Filter the list**

In the GET handler, replace `return c.json({ data });` with:

```ts
    // TRANSITION: the 'default' row is the agent's base prompt, not a skill.
    // Migration 0092 deletes those rows; Task 13 removes this filter.
    return c.json({ data: data.filter((row) => row.name !== 'default') });
```

- [ ] **Step 6: Rewrite the POST body**

Keep the POST handler's permission check, `resolveAgent` check and zod `schema` (lines 102-133) unchanged. Change one line in the schema, the `tools` field comment, to say `// Accepted for compatibility; not stored — nothing reads agent_skills.tools.`. Then replace everything from `// Declared outside the try block...` (line 135) to the end of the handler (line 259) with:

```ts
    try {
        // The cap counts the agent's *other* attached skills. The 'default'
        // row is its base prompt, not a skill (TRANSITION: removed in Task 13),
        // and a re-attach never counts the row it reactivates.
        const active = await db.select({ name: agentSkills.name, installId: agentSkills.installId })
            .from(agentSkills)
            .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.tenantId, tenantId), eq(agentSkills.status, 'active')));
        const others = active.filter((s) => s.name !== 'default'
            && (result.data.installId ? s.installId !== result.data.installId : s.name !== result.data.name));
        if (others.length >= MAX_ATTACHED_SKILLS) {
            return c.json({
                error: `This agent already has the maximum of ${MAX_ATTACHED_SKILLS} skills attached. Detach one first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
        }

        if (result.data.installId) {
            const install = await resolveInstall(result.data.installId, tenantId);
            if (!install) {
                return c.json({ error: 'Skill install not found', code: 'NOT_FOUND' }, 404);
            }
            const manifest = await resolveInstalledSkillManifest(install.skillId, install.installedVersion);
            if (!manifest) {
                return c.json({ error: 'Skill version has no readable content yet', code: 'NOT_READY' }, 409);
            }
            const name = manifest.name ?? result.data.name;

            // An install is attached at most once per agent. Reuse its row,
            // active or archived, so a re-attach after a detach reactivates the
            // same row instead of colliding with it.
            const [existing] = await db.select({ id: agentSkills.id })
                .from(agentSkills)
                .where(and(
                    eq(agentSkills.agentId, agentId),
                    eq(agentSkills.tenantId, tenantId),
                    eq(agentSkills.installId, install.id),
                ))
                .orderBy(sql`(${agentSkills.status} = 'active') desc`, agentSkills.createdAt)
                .limit(1);

            if (existing) {
                const [updated] = await db.update(agentSkills)
                    .set({ name, systemPrompt: manifest.body, status: 'active', updatedAt: new Date() })
                    .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.tenantId, tenantId)))
                    .returning();
                db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_updated', resource: 'agent_skill', resourceId: updated.id, metadata: { agentId, name, reason: 'reattach' }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
                return c.json({ data: updated }, 200);
            }

            const [created] = await db.insert(agentSkills).values({
                agentId,
                tenantId,
                name,
                systemPrompt: manifest.body,
                tools: [],
                config: result.data.config ?? null,
                version: result.data.version ?? 1,
                status: 'active',
                installId: install.id,
            }).returning();
            db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_created', resource: 'agent_skill', resourceId: created.id, metadata: { agentId, name }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
            return c.json({ data: created }, 201);
        }

        if (!result.data.systemPrompt) {
            return c.json({ error: 'systemPrompt is required when installId is omitted', code: 'VALIDATION_ERROR' }, 400);
        }
        const [created] = await db.insert(agentSkills).values({
            agentId,
            tenantId,
            name: result.data.name,
            systemPrompt: result.data.systemPrompt,
            tools: [],
            config: result.data.config ?? null,
            version: result.data.version ?? 1,
            status: 'active',
            installId: null,
        }).returning();
        db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_created', resource: 'agent_skill', resourceId: created.id, metadata: { agentId, name: result.data.name }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
        return c.json({ data: created }, 201);
    } catch (err: any) {
        // The driver wraps the pg error under `.cause` (same shape as
        // userUpsertMiddleware): `err.code` is undefined, `err.cause.code` is '23505'.
        const pgErr = err?.cause ?? err;
        if (pgErr?.code === '23505') {
            if (pgErr.constraint === ACTIVE_INSTALL_UNIQUE) {
                // A concurrent attach of the same install won. The desired end
                // state already holds, and attachSkillToAgent treats CONFLICT
                // as success.
                return c.json({ error: 'This skill is already attached to this agent', code: 'CONFLICT' }, 409);
            }
            return c.json({ error: 'Another skill with this name is already attached to this agent', code: 'NAME_CONFLICT' }, 409);
        }
        console.error('Failed to create skill:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api test agent-skills`
Expected: PASS, 16 tests.

Run: `pnpm --filter @serverless-saas/agent-api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add products/agent-platform/packages/api/routes/agent-skills.ts \
        products/agent-platform/packages/api/__tests__/agent-skills.test.ts
git commit -m "feat(agent-skills): attach by install, reactivate on re-attach, drop the char budget

An installed skill's row takes the manifest name, never the client's, and a
second attach of the same install reuses its row. The list hides the
'default' row until migration 0092 deletes it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The import worker attaches by install

**Files:**
- Modify: `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts`, lines 40-46 (constants) and the attach block (lines 150-208)
- Test: `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`

**Interfaces:**
- Consumes: the `agent_skills_agent_install_active_unique` index (Task 1).
- Produces: a worker attach that never adds a second row for an install already on the agent. It reactivates that row instead.

- [ ] **Step 1: Update and add the tests**

In `skillImport.test.ts`, in the test `'does not attach when the agent already has the maximum attached skills, but the import still succeeds'`, replace its `dbMock.execute.mockImplementation(...)` with:

```ts
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT count(*)')) return [{ n: 8 }];
      return undefined;
    });
```

Then add these tests inside `describe('handleSkillImport', ...)`:

```ts
  it("reactivates the agent's existing row for this install instead of inserting a second", async () => {
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('UPDATE agent_skills')) return [{ id: 'row-1' }];
      return undefined;
    });
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('UPDATE agent_skills');
    expect(executed).not.toContain('INSERT INTO agent_skills');
  });

  it('inserts with ON CONFLICT on the active-install index when no row exists yet', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const insert = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('INSERT INTO agent_skills'));
    expect(insert).toContain('ON CONFLICT (agent_id, install_id)');
    expect(insert).toContain("install_id IS NOT NULL AND status = 'active'");
    expect(insert).not.toContain('(agent_id, tenant_id, name, version)');
  });

  it("doesn't count the agent's 'default' row or this install toward the cap", async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const count = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('SELECT count(*)'));
    expect(count).toContain("s.name <> 'default'");
    expect(count).toContain('s.install_id IS DISTINCT FROM');
  });

  it('has no character budget: a long skill still attaches', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: `---\nname: long-skill\ndescription: "Use when a sample skill description is needed for testing"\n---\n\n${'x'.repeat(30_000)}` },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('INSERT INTO agent_skills');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-worker-handlers test skillImport`
Expected: the four new tests FAIL, and the cap test FAILS because its mock no longer matches.

- [ ] **Step 3: Replace the constants**

Replace the comment block above `MAX_ATTACHED_SKILLS`, and both constants (lines 40-46), with:

```ts
// Same abuse ceiling as the API's attach route
// (products/agent-platform/packages/api/routes/agent-skills.ts). This raw-SQL
// attach has no route in front of it, so it enforces the cap itself.
// Deliberately duplicated rather than shared — see the route file's comment.
const MAX_ATTACHED_SKILLS = 8;
```

- [ ] **Step 4: Replace the attach block**

Inside `if (attachToAgentId) { try {`, replace everything from `// Same budget check as the API's attach route` down to the line before `} catch (attachErr) {` with:

```ts
        // The cap counts the agent's *other* attached skills. The 'default'
        // row is the agent's base prompt, not a skill (TRANSITION: migration
        // 0092 deletes those rows; Task 13 removes this filter), and this
        // install's own row never counts against its re-attach.
        const countRows = ((await db.execute(sql`
          SELECT count(*)::int AS n
          FROM agent_skills s
          WHERE s.agent_id = ${attachToAgentId}::uuid AND s.tenant_id = ${tenantId}::uuid
            AND s.status = 'active' AND s.name <> 'default'
            AND s.install_id IS DISTINCT FROM (
              SELECT si.id FROM skill_installs si
              WHERE si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
              LIMIT 1
            )
        `)) ?? []) as unknown as { n: number }[];
        const otherCount = Number(countRows[0]?.n ?? 0);

        if (otherCount >= MAX_ATTACHED_SKILLS) {
          console.log(`[skillImport] attach skipped: agent already has ${MAX_ATTACHED_SKILLS} skills agentId=${attachToAgentId} skillId=${skillId} version=${version}`);
        } else {
          // An install is attached at most once per agent. Reuse its existing
          // row, active or archived, so a re-import or a re-attach after a
          // detach reactivates it. Both joins are tenant constraints:
          // agent_skills.agent_id and tenant_id are independent foreign keys,
          // so a row pairing this tenant with another tenant's agent must
          // match nothing.
          const reactivated = ((await db.execute(sql`
            UPDATE agent_skills s
            SET status = 'active', name = ${manifest.name}, system_prompt = ${manifestWithBody.body},
                version = ${version}, updated_at = now()
            WHERE s.id = (
              SELECT s2.id FROM agent_skills s2
              JOIN agents a ON a.id = s2.agent_id AND a.tenant_id = ${tenantId}::uuid
              JOIN skill_installs si ON si.id = s2.install_id
                AND si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
              WHERE s2.agent_id = ${attachToAgentId}::uuid AND s2.tenant_id = ${tenantId}::uuid
              ORDER BY (s2.status = 'active') DESC, s2.created_at ASC
              LIMIT 1
            )
            RETURNING s.id
          `)) ?? []) as unknown as { id: string }[];

          if (reactivated.length === 0) {
            // The agents join is a security constraint, not a convenience:
            // selecting a.id FROM agents WHERE a.tenant_id = tenantId makes a
            // mismatched agent/tenant pair write zero rows. This raw insert
            // has no route in front of it on a queue redelivery.
            const result = await db.execute(sql`
              INSERT INTO agent_skills (agent_id, tenant_id, name, system_prompt, tools, version, status, install_id)
              SELECT a.id, a.tenant_id, ${manifest.name}, ${manifestWithBody.body}, '{}', ${version},
                     'active', si.id
              FROM agents a
              JOIN skill_installs si
                ON si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
              WHERE a.id = ${attachToAgentId}::uuid AND a.tenant_id = ${tenantId}::uuid
              ON CONFLICT (agent_id, install_id) WHERE install_id IS NOT NULL AND status = 'active' DO NOTHING
            `);
            // Zero rows affected means one of three things: the ON CONFLICT
            // no-op (a benign redelivery), no active skill_installs row yet
            // for this skill, or an agent outside this tenant, which the join
            // refuses. All three are a silent no-attach unless logged.
            const affected = (result as unknown as { count?: number; length?: number })?.count
              ?? (result as unknown as { length?: number })?.length
              ?? 0;
            if (affected === 0) {
              console.warn(`[skillImport] attach affected 0 rows (agent not in tenant, no matching active skill_installs row, or already attached): agentId=${attachToAgentId} tenantId=${tenantId} skillId=${skillId} version=${version}`);
            }
          }
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-worker-handlers test`
Expected: PASS, including the four new tests and every existing attach test. `constrains the attach INSERT to an agent in the same tenant` still passes, because the INSERT keeps `FROM agents a`, `a.tenant_id =` and `SELECT a.id, a.tenant_id`.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/worker-handlers/handlers/skillImport.ts \
        products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts
git commit -m "feat(skill-import): attach by install and reactivate instead of adding a second row

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Remove the dead tool allowlist sync and the last character budget; point fairness at the agent's prompt

**Files:**
- Delete: `apps/api/src/routes/integrations.sync.ts`
- Modify:
  - `apps/api/src/routes/integrations.ts` (lines 11, 294)
  - `apps/api/src/routes/integrations.nango.webhook.ts` (lines 6, 100)
  - `apps/api/src/routes/integrations.github.callback.ts` (lines 6, 159)
  - `apps/api/src/routes/integrations.callbacks.ts` (lines 6, 70, 130, 193)
- Modify: `apps/api/src/routes/integrations.nango.webhook.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/createSkill.ts` and `createSkill.test.ts`
- Modify: `products/agent-platform/packages/api/routes/agents.fairness.ts` (around line 76), `ops.fairness.ts` (around line 81)

**Interfaces:**
- Consumes: `agents.systemPrompt` (Task 1).
- Produces: nothing writes `agent_skills.tools` any more. The column stays until the fairness routes stop reading it, which is out of scope.

**Why `integrations.sync.ts` goes entirely:** it does two things, and neither has an effect.
- It merges provider tools into `agent_skills.tools`, which nothing reads at runtime. Both runtime paths pass `enabledTools: null`, per `tasks.execution.ts:79` and `documents.ts:213`. It also writes into the first unordered active row of the first unordered active agent.
- It POSTs to `${AGENT_ORCHESTRATOR_URL}/update/:tenantId/:agentId`, and the orchestrator has no such route.

- [ ] **Step 1: Update the webhook tests so they stop asserting on the sync**

In `apps/api/src/routes/integrations.nango.webhook.test.ts`:
- Delete line 9: `vi.mock('./integrations.sync', () => ({ syncToolsAndNotifyRelay: vi.fn() }));`
- Delete line 12: `import { syncToolsAndNotifyRelay } from './integrations.sync';`
- Delete line 84: `expect(syncToolsAndNotifyRelay).toHaveBeenCalledWith('tenant-1', 'gmail', 'add');`. The test keeps its audit-row assertion.
- Line 102 is in `'falls back to connectionId if endUser is absent'`, where the sync call was the only proof of the fallback. Replace it with an assertion on the audit row's tenant:

```ts
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
```

- Delete line 115: `expect(syncToolsAndNotifyRelay).not.toHaveBeenCalled();`. The test keeps `expect(db.execute).not.toHaveBeenCalled()`.

- [ ] **Step 2: Delete the sync and its six call sites**

- Delete `apps/api/src/routes/integrations.sync.ts`.
- In each of the four caller files:
  - delete the `import { syncToolsAndNotifyRelay } from './integrations.sync';` line;
  - delete every `void syncToolsAndNotifyRelay(...);` statement (the line numbers are in **Files** above).

Then run:

```bash
grep -rn "syncToolsAndNotifyRelay\|integrations.sync" apps/api/src
```

Expected: no output.

- [ ] **Step 3: Drop the character budget from the create_skill tool**

In `apps/agent-orchestrator/src/mastra/tools/createSkill.ts`:
- Delete the `MAX_COMPOSED_SKILL_CHARS` comment and constant (lines 7-12).
- In the `MIN_DESCRIPTION_LENGTH` comment (lines 16-19), replace `same cross-package boundary as MAX_COMPOSED_SKILL_CHARS above.` with `the worker package is not a dependency of the orchestrator.`
- Inside `validateSkillBody`, delete the composition-budget comment and its `if (body.length + name.length + 15 > MAX_COMPOSED_SKILL_CHARS) { ... }` block (lines 44-56). Keep the `MAX_BODY_BYTES` check above it.
- If type-check or lint then flags `name` as an unused parameter of `validateSkillBody`, rename it `_name`. Don't change the call sites.

In `apps/agent-orchestrator/src/mastra/tools/createSkill.test.ts`:
- Delete the `MAX_COMPOSED_SKILL_CHARS` constant and its comment (lines 7-8).
- Delete the comment above `'rejects a body that could never fit the composition budget, retryably'` (lines 78-80), that test, and `'accepts a body sitting exactly on the composition budget'` (lines 81-99).
- Add in their place:

```ts
  // Native Mastra skills are loaded on demand, not concatenated into every
  // prompt, so the old 24,000-character composition budget no longer
  // measures anything. Only the 64KB SKILL.md size limit remains.
  it('accepts a long body that is under the 64KB limit', async () => {
    const body = `---\nname: a\ndescription: Use when writing bids for prospective clients\n---\n\n${'x'.repeat(30_000)}`
    const result = await run({ name: 'Bid Writer', body })
    expect(result.success).toBe(true)
  })
```

- [ ] **Step 4: Point the fairness checks at the agent's prompt**

In `products/agent-platform/packages/api/routes/agents.fairness.ts`, change the agent select and the `texts` array to:

```ts
  const [agent] = await db.select({ id: agents.id, description: agents.description, systemPrompt: agents.systemPrompt })
    .from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
```

```ts
  const texts = [agent.description ?? '', agent.systemPrompt ?? '', ...skills.map((s: { systemPrompt: string; tools: string[] }) => s.systemPrompt), ...skills.flatMap((s: { systemPrompt: string; tools: string[] }) => s.tools)];
```

In `products/agent-platform/packages/api/routes/ops.fairness.ts`, do the same:
- add `systemPrompt: agents.systemPrompt` to the agent select;
- add `agent.systemPrompt ?? '',` as the second entry of `texts`.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @serverless-saas/api test integrations
pnpm --filter agent-orchestrator test createSkill
pnpm --filter @serverless-saas/api exec tsc --noEmit
pnpm --filter @serverless-saas/agent-api exec tsc --noEmit
```

Expected: all PASS or exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/integrations.ts apps/api/src/routes/integrations.nango.webhook.ts \
        apps/api/src/routes/integrations.github.callback.ts apps/api/src/routes/integrations.callbacks.ts \
        apps/api/src/routes/integrations.nango.webhook.test.ts \
        apps/agent-orchestrator/src/mastra/tools/createSkill.ts apps/agent-orchestrator/src/mastra/tools/createSkill.test.ts \
        products/agent-platform/packages/api/routes/agents.fairness.ts products/agent-platform/packages/api/routes/ops.fairness.ts
git rm apps/api/src/routes/integrations.sync.ts
git commit -m "refactor: delete the dead tool-allowlist sync and the last character budget

integrations.sync wrote agent_skills.tools, which nothing reads, and called
an orchestrator route that does not exist. Fairness checks now include the
agent's own prompt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The conversation PATCH stores the invoked-skill list

**Files:**
- Modify: `products/agent-platform/packages/api/routes/conversations.ts:263-306` (the PATCH schema and metadata merge)
- Create: `products/agent-platform/packages/api/__tests__/conversations.invokedSkills.test.ts`

**Interfaces:**
- Produces: `PATCH /conversations/:id` accepts `invokedSkills: Array<{ installId: string (uuid); skillId: string (uuid); name: string (1-100) }> | null`, at most 8 entries.
  - The list is stored at `metadata.invokedSkills`, merged, never overwriting other keys.
  - `null` deletes the key.
  - Task 8 (orchestrator) and Task 10 (web) both write it.
- The server does not trust these ids: the orchestrator re-resolves every entry against the tenant's own active installs on every turn (Task 8). `name` is display text for chips only.

- [ ] **Step 1: Write the failing tests**

Create `products/agent-platform/packages/api/__tests__/conversations.invokedSkills.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Same harness as conversations.folderScope.test.ts: assert the payload
// handed to db.update().set(), which is the real merge behaviour.
vi.mock('@serverless-saas/database/client', () => ({
    db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock('@serverless-saas/agent-schema/conversations', () => ({ conversations: {} }));
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agents: {} }));
vi.mock('@serverless-saas/agent-schema/personas', () => ({ personas: {} }));
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: () => true }));

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'conversations', action: 'update' }],
        });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

function mockDb(db: any, existingMetadata: unknown) {
    const setSpy = vi.fn().mockReturnValue({ where: async () => undefined });
    db.update.mockReturnValue({ set: setSpy });
    let call = 0;
    db.select.mockImplementation(() => {
        const isFirst = call++ === 0;
        const rows = isFirst
            ? [{ id: 'conv-1', metadata: existingMetadata }]
            : [{ id: 'conv-1', metadata: existingMetadata, agent: { id: 'a1', name: 'A', type: 'platform', persona: null } }];
        const terminal = { where: () => ({ limit: async () => rows }) };
        return { from: () => ({ ...terminal, innerJoin: () => ({ leftJoin: () => terminal }) }) };
    });
    return setSpy;
}

async function patch(body: unknown, existingMetadata: unknown = null) {
    const { db } = await import('@serverless-saas/database/client');
    vi.clearAllMocks();
    const setSpy = mockDb(db, existingMetadata);
    const { conversationsRoutes } = await import('../routes/conversations');
    const app = appWithContext();
    app.route('/conversations', conversationsRoutes);
    const res = await app.request('/conversations/conv-1', {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
    return { res, setSpy };
}

const SKILL = {
    installId: '11111111-1111-4111-8111-111111111111',
    skillId: '22222222-2222-4222-8222-222222222222',
    name: 'UGC Ad Production',
};

describe('PATCH /conversations/:id — invokedSkills', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists the list under metadata.invokedSkills', async () => {
        const { res, setSpy } = await patch({ invokedSkills: [SKILL] });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({ invokedSkills: [SKILL] });
    });

    it('clears the list when given null', async () => {
        const { res, setSpy } = await patch({ invokedSkills: null }, { invokedSkills: [SKILL] });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({});
    });

    it('merges into metadata rather than overwriting it', async () => {
        const { setSpy } = await patch({ invokedSkills: [SKILL] }, { allowMode: 'auto', testSkillInstallId: SKILL.installId });
        expect(setSpy.mock.calls[0][0].metadata).toEqual({
            allowMode: 'auto', testSkillInstallId: SKILL.installId, invokedSkills: [SKILL],
        });
    });

    it('rejects a non-uuid installId', async () => {
        const { res } = await patch({ invokedSkills: [{ ...SKILL, installId: 'nope' }] });
        expect(res.status).toBe(400);
    });

    it('rejects more than 8 invoked skills', async () => {
        const nine = Array.from({ length: 9 }, () => SKILL);
        const { res } = await patch({ invokedSkills: nine });
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @serverless-saas/agent-api test conversations.invokedSkills`
Expected: FAIL. `invokedSkills` isn't in the schema, so the first test's `metadata` is undefined.

- [ ] **Step 3: Accept and merge the field**

In `products/agent-platform/packages/api/routes/conversations.ts`, add this to the PATCH `schema` object after `testSkillInstallId`:

```ts
            // Skills turned on in this conversation with "/" — written by the
            // orchestrator on the turn a skill is invoked, and by the composer
            // when a chip's X removes one. Never trusted: the orchestrator
            // re-resolves every entry against this tenant's active installs on
            // every turn. `name` is chip display text only.
            invokedSkills: z.array(z.object({
                installId: z.string().uuid(),
                skillId: z.string().uuid(),
                name: z.string().min(1).max(100),
            })).max(8).nullable().optional(),
```

Change the destructure and the merge guard to:

```ts
        const { folderScope, allowMode, testSkillInstallId, invokedSkills, ...rest } = result.data;
        const patch: Record<string, unknown> = { ...rest };
        if (folderScope !== undefined || allowMode !== undefined || testSkillInstallId !== undefined || invokedSkills !== undefined) {
```

Inside that block, after the `testSkillInstallId` branch, add:

```ts
            if (invokedSkills !== undefined) {
                if (invokedSkills === null) delete current.invokedSkills;
                else current.invokedSkills = invokedSkills;
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @serverless-saas/agent-api test conversations`
Expected: PASS: the 5 new tests, plus every existing `conversations.*` test.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/conversations.ts \
        products/agent-platform/packages/api/__tests__/conversations.invokedSkills.test.ts
git commit -m "feat(conversations): store the skills turned on with \"/\" on the conversation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The orchestrator resolves `/` picks and records them on the conversation

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/skillInvocation.ts` and `apps/agent-orchestrator/src/mastra/__tests__/skillInvocation.test.ts`
- Modify: `apps/agent-orchestrator/src/usage.ts` (add `resolveInvokedSkills`) and `usage.test.ts`
- Modify: `apps/agent-orchestrator/src/persistence.ts`:
  - replace `fetchConversationTestSkillInstallId` (lines 57-75) with `fetchConversationSkillSettings`;
  - add `saveConversationInvokedSkills`.
- Create: `apps/agent-orchestrator/src/__tests__/persistence.skills.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/context.ts` (two fields)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`:
  - the imports;
  - the `Promise.all` at lines 263-272;
  - the `testSkillInstallId` line at 276;
  - a new block after `activeAgent` (line 296).
- Modify: `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts` (mocks at lines 51-58 and 94-101)

**Interfaces:**
- Consumes: `PATCH /conversations/:id` with `invokedSkills` (Task 7).
- Produces, for Task 9:
  - `InvokedSkill = { installId: string; skillId: string; name: string }` and `MAX_INVOKED_SKILLS = 8`, exported from `mastra/skillInvocation.ts`;
  - `mergeInvokedSkills(existing: InvokedSkill[], added: InvokedSkill[]): { merged: InvokedSkill[]; newlyInvoked: InvokedSkill[] }`, same module;
  - `resolveInvokedSkills(skillIds: string[], tenantId: string): Promise<InvokedSkill[]>` in `usage.ts`;
  - `fetchConversationSkillSettings(idToken, conversationId): Promise<{ testSkillInstallId: string | null; invokedSkills: InvokedSkill[] }>` and `saveConversationInvokedSkills(idToken, conversationId, invokedSkills): void` in `persistence.ts`;
  - on Olmo's turns, `requestContext` carries two keys:
    - `invokedSkillInstallIds: string[]` (every skill on in this conversation);
    - `skillsInvokedThisTurn: string[]`, the Mastra skill names (`toMastraSkillName` of the skill name) turned on by *this* message.

- [ ] **Step 1: Write the failing tests for the pure merge**

Create `apps/agent-orchestrator/src/mastra/__tests__/skillInvocation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeInvokedSkills, MAX_INVOKED_SKILLS, type InvokedSkill } from '../skillInvocation.js'

const skill = (n: number): InvokedSkill => ({ installId: `install-${n}`, skillId: `skill-${n}`, name: `Skill ${n}` })

describe('mergeInvokedSkills', () => {
  it('adds newly picked skills after the existing ones', () => {
    const { merged, newlyInvoked } = mergeInvokedSkills([skill(1)], [skill(2)])
    expect(merged).toEqual([skill(1), skill(2)])
    expect(newlyInvoked).toEqual([skill(2)])
  })

  it('does not re-invoke a skill already on in the conversation', () => {
    const { merged, newlyInvoked } = mergeInvokedSkills([skill(1)], [skill(1)])
    expect(merged).toEqual([skill(1)])
    expect(newlyInvoked).toEqual([])
  })

  it('dedupes within one message', () => {
    const { newlyInvoked } = mergeInvokedSkills([], [skill(1), skill(1)])
    expect(newlyInvoked).toEqual([skill(1)])
  })

  it(`caps the conversation at ${MAX_INVOKED_SKILLS}, keeping the existing ones`, () => {
    const existing = Array.from({ length: 7 }, (_, i) => skill(i))
    const { merged, newlyInvoked } = mergeInvokedSkills(existing, [skill(100), skill(101)])
    expect(merged).toHaveLength(MAX_INVOKED_SKILLS)
    expect(newlyInvoked).toEqual([skill(100)])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter agent-orchestrator test skillInvocation`
Expected: FAIL, because `../skillInvocation.js` does not exist.

- [ ] **Step 3: Create the module**

Create `apps/agent-orchestrator/src/mastra/skillInvocation.ts`:

```ts
// "/" in chat turns a skill on for one conversation, the way Claude Code's
// /skill-name does: it never attaches the skill to the agent. See
// docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
//
// Pure on purpose: no database or Mastra runtime imports, so the merge and
// forcing rules are unit-testable without platformAgent's DB singletons.

export interface InvokedSkill {
  installId: string
  skillId: string
  /** The skill's display name, as stored on the conversation for chips. */
  name: string
}

/** A conversation keeps at most this many "/" skills, matching the per-agent cap. */
export const MAX_INVOKED_SKILLS = 8

/**
 * Adds this message's "/" picks to the conversation's invoked list.
 * `newlyInvoked` is what this message actually turned on — the skills whose
 * instructions this turn must load. A skill already on is not re-invoked, and
 * the cap keeps the existing skills and drops the newest extras.
 */
export function mergeInvokedSkills(
  existing: InvokedSkill[],
  added: InvokedSkill[],
): { merged: InvokedSkill[]; newlyInvoked: InvokedSkill[] } {
  const merged = [...existing]
  const newlyInvoked: InvokedSkill[] = []
  for (const skill of added) {
    if (merged.length >= MAX_INVOKED_SKILLS) break
    if (merged.some((s) => s.installId === skill.installId)) continue
    merged.push(skill)
    newlyInvoked.push(skill)
  }
  return { merged, newlyInvoked }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter agent-orchestrator test skillInvocation`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing tests for tenant-scoped resolution**

In `apps/agent-orchestrator/src/usage.test.ts`:
- add `resolveInvokedSkills` to the import from `./usage.js`;
- add:

```ts
describe('resolveInvokedSkills', () => {
  const SKILL_ID = '22222222-2222-4222-8222-222222222222'

  it("resolves a picked skill id to this tenant's active install", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ install_id: 'install-1', skill_id: SKILL_ID, name: 'UGC Ad Production' }] })
    const result = await resolveInvokedSkills([SKILL_ID], 'tenant-1')
    expect(result).toEqual([{ installId: 'install-1', skillId: SKILL_ID, name: 'UGC Ad Production' }])
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('si.tenant_id = $1')
    expect(sql).toContain("si.status = 'active'")
    expect(params).toEqual(['tenant-1', [SKILL_ID]])
  })

  it('drops ids that are not uuids without querying, so a forged id never reaches SQL', async () => {
    const result = await resolveInvokedSkills(['not-a-uuid', "'; drop table skills; --"], 'tenant-1')
    expect(result).toEqual([])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns nothing, without querying, when nothing was picked', async () => {
    await expect(resolveInvokedSkills([], 'tenant-1')).resolves.toEqual([])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns an empty list instead of throwing on a database error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'))
    await expect(resolveInvokedSkills([SKILL_ID], 'tenant-1')).resolves.toEqual([])
  })
})
```

- [ ] **Step 6: Add `resolveInvokedSkills`**

In `apps/agent-orchestrator/src/usage.ts`:
- add `import { MAX_INVOKED_SKILLS, type InvokedSkill } from './mastra/skillInvocation.js'` to the imports;
- add after `fetchTestSkill`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolves "/" picks — catalog skill ids sent by the client — to this
 * tenant's own active installs. The client is never trusted: an id that is
 * not a uuid, not installed by this tenant, or not active is dropped, so a
 * forged id cannot reach another tenant's skill.
 */
export async function resolveInvokedSkills(skillIds: string[], tenantId: string): Promise<InvokedSkill[]> {
  const ids = [...new Set(skillIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_INVOKED_SKILLS)
  if (!tenantId || ids.length === 0) return []
  try {
    const res = await getPool().query<{ install_id: string; skill_id: string; name: string }>(
      `SELECT si.id AS install_id, s.id AS skill_id, s.name
       FROM skill_installs si
       JOIN skills s ON s.id = si.skill_id
       WHERE si.tenant_id = $1 AND si.status = 'active' AND si.skill_id = ANY($2::uuid[])`,
      [tenantId, ids],
    )
    return res.rows.map((r) => ({ installId: r.install_id, skillId: r.skill_id, name: r.name }))
  } catch (err) {
    console.error('[usage] resolveInvokedSkills error:', (err as Error).message)
    return []
  }
}
```

Run: `pnpm --filter agent-orchestrator test usage.test`
Expected: PASS.

- [ ] **Step 7: Write the failing persistence tests**

Create `apps/agent-orchestrator/src/__tests__/persistence.skills.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchConversationSkillSettings, saveConversationInvokedSkills } from '../persistence.js'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

const SKILL = { installId: '11111111-1111-4111-8111-111111111111', skillId: '22222222-2222-4222-8222-222222222222', name: 'UGC Ad Production' }

function ok(metadata: unknown) {
  return { ok: true, json: async () => ({ data: { metadata } }) }
}

describe('fetchConversationSkillSettings', () => {
  it('reads the test skill and the invoked list off the conversation', async () => {
    fetchMock.mockResolvedValueOnce(ok({ testSkillInstallId: 'install-t', invokedSkills: [SKILL] }))
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: 'install-t', invokedSkills: [SKILL] })
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/conversations/conv-1')
  })

  it('drops malformed invoked entries', async () => {
    fetchMock.mockResolvedValueOnce(ok({ invokedSkills: [SKILL, { installId: 5 }, null, 'x'] }))
    const result = await fetchConversationSkillSettings('token', 'conv-1')
    expect(result.invokedSkills).toEqual([SKILL])
  })

  it('returns empty settings for a conversation that is not the caller\'s (404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: null, invokedSkills: [] })
  })

  it('returns empty settings on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'))
    await expect(fetchConversationSkillSettings('token', 'conv-1')).resolves.toEqual({ testSkillInstallId: null, invokedSkills: [] })
  })
})

describe('saveConversationInvokedSkills', () => {
  it('PATCHes the full invoked list onto the conversation as the user', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true })
    saveConversationInvokedSkills('token', 'conv-1', [SKILL])
    await Promise.resolve()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v1/conversations/conv-1')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer token')
    expect(JSON.parse(init.body)).toEqual({ invokedSkills: [SKILL] })
  })
})
```

Run: `pnpm --filter agent-orchestrator test persistence.skills`
Expected: FAIL, because neither function exists.

- [ ] **Step 8: Replace the persistence function**

In `apps/agent-orchestrator/src/persistence.ts`:
- add `import type { InvokedSkill } from './mastra/skillInvocation.js'` to the imports;
- replace `fetchConversationTestSkillInstallId` and its comment (lines 57-75) with:

```ts
export interface ConversationSkillSettings {
  /** Set only on a Test-in-chat conversation: that conversation runs exactly this one skill. */
  testSkillInstallId: string | null
  /** Skills turned on in this conversation with "/". */
  invokedSkills: InvokedSkill[]
}

const EMPTY_SKILL_SETTINGS: ConversationSkillSettings = { testSkillInstallId: null, invokedSkills: [] }

function isInvokedSkill(v: unknown): v is InvokedSkill {
  const s = v as Record<string, unknown> | null
  return !!s && typeof s === 'object'
    && typeof s.installId === 'string' && typeof s.skillId === 'string' && typeof s.name === 'string'
}

// Same ownership-check reasoning as fetchConversationAllowMode above: these
// values are read back off the conversation row, scoped to (tenantId, userId)
// server-side by GET /conversations/:id, so a stranger's conversationId 404s
// and falls back to no skills. Even so, every invoked entry is re-resolved
// against the tenant's active installs before anything loads it.
export async function fetchConversationSkillSettings(idToken: string, conversationId: string): Promise<ConversationSkillSettings> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversations/${conversationId}`, {
      headers: { 'Authorization': `Bearer ${idToken}` },
    })
    if (!res.ok) return EMPTY_SKILL_SETTINGS
    const json = await res.json() as { data?: { metadata?: { testSkillInstallId?: unknown; invokedSkills?: unknown } } }
    const metadata = json.data?.metadata ?? {}
    return {
      testSkillInstallId: typeof metadata.testSkillInstallId === 'string' ? metadata.testSkillInstallId : null,
      invokedSkills: Array.isArray(metadata.invokedSkills) ? metadata.invokedSkills.filter(isInvokedSkill) : [],
    }
  } catch (err) {
    console.error('[persistence] fetchConversationSkillSettings error:', (err as Error).message)
    return EMPTY_SKILL_SETTINGS
  }
}

// Fire-and-forget, like saveUserMessage: the list only has to be there for
// the NEXT turn, and a lost write means a "/" skill is not remembered, never
// that something is loaded that shouldn't be.
export function saveConversationInvokedSkills(idToken: string, conversationId: string, invokedSkills: InvokedSkill[]): void {
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: authHeaders(idToken),
    body: JSON.stringify({ invokedSkills }),
  }).then(async (res) => {
    if (!res.ok) console.error(`[persistence] saveConversationInvokedSkills status: ${res.status} body: ${await res.text().catch(() => '')}`)
  }).catch((err: Error) => {
    console.error('[persistence] saveConversationInvokedSkills error:', err.message)
  })
}
```

Run: `pnpm --filter agent-orchestrator test persistence.skills`
Expected: PASS, 5 tests.

- [ ] **Step 9: Add the two context fields**

In `apps/agent-orchestrator/src/mastra/context.ts`, inside `tenantContextSchema`, after `testSkillInstallId`, add:

```ts
  // Install ids of every skill turned on in this conversation with "/",
  // already resolved against this tenant's active installs. Set by
  // chatStream.ts on Olmo's turns; read by platformAgent's skills resolver.
  invokedSkillInstallIds: z.array(z.string()).optional(),
  // Mastra skill names (toMastraSkillName) turned on by THIS message. Drives
  // the forced skill-tool steps and the instruction line naming them; empty
  // on every later turn of the conversation.
  skillsInvokedThisTurn: z.array(z.string()).optional(),
```

- [ ] **Step 10: Wire it into chatStream**

In `apps/agent-orchestrator/src/routes/chatStream.ts`:
- In the `../persistence.js` import, replace `fetchConversationTestSkillInstallId` with `fetchConversationSkillSettings, saveConversationInvokedSkills`.
- Add `resolveInvokedSkills, recordSkillRuns, toMastraSkillName` to the `../usage.js` import.
- Add `import { mergeInvokedSkills } from '../mastra/skillInvocation.js'`.
- In the `Promise.all` (lines 263-272):
  - rename the first destructured variable from `testSkillInstallId` to `skillSettings`;
  - replace `fetchConversationTestSkillInstallId(idToken, conversationId),` with `fetchConversationSkillSettings(idToken, conversationId),`.
- Replace `if (testSkillInstallId) requestContext.set('testSkillInstallId', testSkillInstallId)` with:

```ts
    if (skillSettings.testSkillInstallId) requestContext.set('testSkillInstallId', skillSettings.testSkillInstallId)
```

- Directly after the `console.log(... agent="..." → ...)` line that follows `const activeAgent = resolveAgent(agentName ?? '')`, add:

```ts
    // "/" turns a skill on for this conversation — never attaches it to the
    // agent. Only Olmo resolves skills, and a Test-in-chat conversation runs
    // exactly its one skill, so neither loads invoked skills.
    let skillsInvokedThisTurn: string[] = []
    if ((activeAgent as unknown) === (platformAgent as unknown) && !skillSettings.testSkillInstallId) {
      const picked = await resolveInvokedSkills((skillsUsed ?? []).map((s) => s.id), tenantId)
      const { merged, newlyInvoked } = mergeInvokedSkills(skillSettings.invokedSkills, picked)
      if (newlyInvoked.length > 0) {
        saveConversationInvokedSkills(idToken, conversationId, merged)
        recordSkillRuns(newlyInvoked.map((s) => s.installId), tenantId)
          .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRuns failed:`, (err as Error).message))
      }
      skillsInvokedThisTurn = newlyInvoked.map((s) => toMastraSkillName(s.name))
      requestContext.set('invokedSkillInstallIds', merged.map((s) => s.installId))
      requestContext.set('skillsInvokedThisTurn', skillsInvokedThisTurn)
    }
```

`skillsInvokedThisTurn` is used again in Task 9.

- [ ] **Step 11: Update the tool-approval test's mocks**

In `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts`:
- In the `vi.mock('../persistence.js', ...)` factory, replace `fetchConversationTestSkillInstallId: vi.fn().mockResolvedValue(null),` with:

```ts
  fetchConversationSkillSettings: vi.fn().mockResolvedValue({ testSkillInstallId: null, invokedSkills: [] }),
  saveConversationInvokedSkills: vi.fn(),
```

- In the `vi.mock('../usage.js', ...)` factory, add:

```ts
  resolveInvokedSkills: vi.fn().mockResolvedValue([]),
  recordSkillRuns: vi.fn().mockResolvedValue(undefined),
  toMastraSkillName: (raw: string) => raw.toLowerCase(),
```

- [ ] **Step 12: Run the orchestrator suite and type-check**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: every test passes except the two pre-existing failures (`serverTools.test.ts`, `tasks-execute.test.ts`); type-check exits 0.

- [ ] **Step 13: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/skillInvocation.ts \
        apps/agent-orchestrator/src/mastra/__tests__/skillInvocation.test.ts \
        apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts \
        apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/__tests__/persistence.skills.test.ts \
        apps/agent-orchestrator/src/mastra/context.ts apps/agent-orchestrator/src/routes/chatStream.ts \
        apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts
git commit -m "feat(orchestrator): resolve \"/\" picks to the tenant's installs and keep them on the conversation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Olmo loads invoked skills through Mastra's own `skill` tool

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/skillInvocation.ts` and its test
- Modify: `apps/agent-orchestrator/src/usage.ts` (add `fetchInvokedSkills`) and `usage.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`: the `instructions` resolver's `return` line, and the `skills` resolver (lines 337-351)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`, the `stream()` call

**Interfaces:**
- Consumes: `invokedSkillInstallIds` and `skillsInvokedThisTurn` on `requestContext`, and the local `skillsInvokedThisTurn` in `chatStream.ts` (Task 8).
- Produces, all in `skillInvocation.ts`:
  - `buildSkillInvocationPrepareStep(count: number)`;
  - `invokedSkillsInstruction(names: string[]): string`;
  - `mergeSkillSets<T extends { name: string }>(attached: T[], invoked: T[]): T[]`.

  Also `fetchInvokedSkills(installIds: string[], tenantId: string): Promise<InlineSkill[]>` in `usage.ts`.

**Why this is Mastra-native:** Mastra 1.64 gives any agent with skills a `skill` tool (`createSkillTool`, input `{ name }`). It resolves the name against *this request's* skills and returns the instructions, which "remain in the conversation as a tool result" (Mastra `docs-sandbox-skills.md`). `prepareStep` is a per-call option: it receives `stepNumber` and may return `toolChoice` for that step only (`processors/index.d.ts:210-216`). So the only code of ours is a step counter and one sentence naming the skills.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent-orchestrator/src/mastra/__tests__/skillInvocation.test.ts`:
- `buildSkillInvocationPrepareStep, invokedSkillsInstruction, mergeSkillSets` in the import;
- these tests:

```ts
describe('buildSkillInvocationPrepareStep', () => {
  it('forces the skill tool for exactly as many steps as skills were invoked', () => {
    const prepareStep = buildSkillInvocationPrepareStep(2)!
    expect(prepareStep({ stepNumber: 0 })).toEqual({ toolChoice: { type: 'tool', toolName: 'skill' } })
    expect(prepareStep({ stepNumber: 1 })).toEqual({ toolChoice: { type: 'tool', toolName: 'skill' } })
    expect(prepareStep({ stepNumber: 2 })).toBeUndefined()
  })

  it('returns no prepareStep at all on a turn with no invocation', () => {
    expect(buildSkillInvocationPrepareStep(0)).toBeUndefined()
  })
})

describe('invokedSkillsInstruction', () => {
  it('names the skills the forced steps must load', () => {
    const text = invokedSkillsInstruction(['ugc-ad-production', 'design-taste'])
    expect(text).toContain('ugc-ad-production, design-taste')
    expect(text).toContain('skill tool')
  })

  it('adds nothing on a turn with no invocation', () => {
    expect(invokedSkillsInstruction([])).toBe('')
  })
})

describe('mergeSkillSets', () => {
  it('keeps attached skills first and lists a skill that is both attached and invoked once', () => {
    const merged = mergeSkillSets([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'c' }])
    expect(merged.map((s) => s.name)).toEqual(['a', 'b', 'c'])
  })
})
```

Add to `apps/agent-orchestrator/src/usage.test.ts`:
- `fetchInvokedSkills` in the import;
- these tests:

```ts
describe('fetchInvokedSkills', () => {
  it('resolves each invoked install into a Mastra Skill, tenant-scoped', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'UGC Ad Production', description: 'Use when making UGC ads.', body: 'Hook in 2 seconds.' }] })
    const skills = await fetchInvokedSkills(['install-1'], 'tenant-1')
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('ugc-ad-production')
    expect(skills[0].instructions).toBe('Hook in 2 seconds.')
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['install-1', 'tenant-1'])
  })

  it('skips an install that no longer resolves (uninstalled, foreign, not ready)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await expect(fetchInvokedSkills(['install-gone'], 'tenant-1')).resolves.toEqual([])
  })

  it('does not record a run: chatStream records one on the invoking turn only', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'X', description: 'Use when X.', body: 'Do X.' }] })
    await fetchInvokedSkills(['install-1'], 'tenant-1')
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter agent-orchestrator test skillInvocation usage.test`
Expected: FAIL, because none of the four functions exist yet.

- [ ] **Step 3: Add the pure helpers**

Append to `apps/agent-orchestrator/src/mastra/skillInvocation.ts`:

```ts
/**
 * On the turn skills are invoked, force the first `count` steps to call
 * Mastra's own `skill` tool, so their instructions are loaded before the
 * agent answers — the native equivalent of Claude Code's /skill-name. After
 * that turn nothing is forced: the loaded instructions stay in the
 * conversation as tool results, and the skills stay in the resolver's set
 * so the agent can call `skill` again if they fall out of context.
 */
export function buildSkillInvocationPrepareStep(
  count: number,
): ((args: { stepNumber: number }) => { toolChoice: { type: 'tool'; toolName: 'skill' } } | undefined) | undefined {
  if (count <= 0) return undefined
  return ({ stepNumber }) => (stepNumber < count ? { toolChoice: { type: 'tool', toolName: 'skill' } } : undefined)
}

/** One sentence naming this turn's invoked skills, so the forced `skill` calls load the right ones. */
export function invokedSkillsInstruction(names: string[]): string {
  if (names.length === 0) return ''
  return `\n\n## Skills the user turned on\nThe user turned on these skills with "/" in this message: ${names.join(', ')}. Activate each one with the skill tool, using exactly these names, before you answer.`
}

/** Attached skills first; a skill that is both attached and invoked appears once. */
export function mergeSkillSets<T extends { name: string }>(attached: T[], invoked: T[]): T[] {
  const byName = new Map<string, T>()
  for (const skill of [...attached, ...invoked]) if (!byName.has(skill.name)) byName.set(skill.name, skill)
  return [...byName.values()]
}
```

- [ ] **Step 4: Add `fetchInvokedSkills`**

In `apps/agent-orchestrator/src/usage.ts`, after `resolveInvokedSkills`, add:

```ts
/**
 * The conversation's "/" skills as native Mastra Skills, for platformAgent's
 * skills resolver. Content is resolved fresh from each pinned install,
 * tenant-scoped, so an uninstalled or foreign install drops out on the next
 * turn. Does not record runs — chatStream records one on the invoking turn.
 */
export async function fetchInvokedSkills(installIds: string[], tenantId: string): Promise<InlineSkill[]> {
  const skills: InlineSkill[] = []
  for (const installId of installIds.slice(0, MAX_INVOKED_SKILLS)) {
    const content = await resolveInstalledSkillContent(installId, tenantId)
    if (!content) continue
    try {
      skills.push(createSkill({ name: toMastraSkillName(content.name), description: content.description, instructions: content.body }))
    } catch (err) {
      console.error('[usage] fetchInvokedSkills createSkill validation failed for', content.name, ':', (err as Error).message)
    }
  }
  return skills
}
```

- [ ] **Step 5: Wire the resolver and the instruction line**

In `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`:
- add `fetchInvokedSkills` to the `../../usage.js` import;
- add `import { invokedSkillsInstruction, mergeSkillSets } from '../skillInvocation.js'`.

In the `instructions` resolver, replace the final `return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT` with:

```ts
    const invokedThisTurn = (requestContext?.get('skillsInvokedThisTurn') as string[] | undefined) ?? []
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
      + invokedSkillsInstruction(invokedThisTurn)
```

In the `skills` resolver, replace the final `return fetchAttachedSkills(agentId, tenantId)` with:

```ts
    // The agent's attached skills, plus the skills turned on in this
    // conversation with "/" (already resolved against this tenant's installs
    // by chatStream.ts). Both are native Mastra skills: listed by name and
    // description, loaded with the built-in `skill` tool.
    const invokedIds = (requestContext?.get('invokedSkillInstallIds') as string[] | undefined) ?? []
    const [attached, invoked] = await Promise.all([
      fetchAttachedSkills(agentId, tenantId),
      invokedIds.length > 0 ? fetchInvokedSkills(invokedIds, tenantId) : Promise.resolve([]),
    ])
    return mergeSkillSets(attached, invoked)
```

- [ ] **Step 6: Force the `skill` tool on the invoking turn**

In `apps/agent-orchestrator/src/routes/chatStream.ts`:
- add `buildSkillInvocationPrepareStep` to the `../mastra/skillInvocation.js` import;
- directly after the `olmoOptions` declaration, add:

```ts
    // Mastra-native: force the built-in skill tool for the first N steps of
    // the turn that invoked N skills, so their instructions load before the
    // answer. Undefined on every other turn, so nothing is forced.
    const skillInvocationPrepareStep = buildSkillInvocationPrepareStep(skillsInvokedThisTurn.length)
```

- in the initial `(activeAgent as any).stream(mastraMessage, { ... })` call, add after `...olmoOptions,`:

```ts
        ...(skillInvocationPrepareStep ? { prepareStep: skillInvocationPrepareStep } : {}),
```

Leave the approve/decline resume calls unchanged. The forced steps belong to the invoking turn's first steps. A resumed run continues after the skills are already loaded.

- [ ] **Step 7: Run the tests and type-check**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: all pass except the two pre-existing failures; type-check exits 0.

The resolver and `stream()` wiring have no unit harness: `platformAgent.ts` builds DB singletons at import time. They are exercised by rollout check 5 (a `/` pick loads the skill live).

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/skillInvocation.ts \
        apps/agent-orchestrator/src/mastra/__tests__/skillInvocation.test.ts \
        apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts \
        apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(orchestrator): load \"/\" skills through Mastra's native skill tool

The resolver adds the conversation's invoked skills to the agent's own, and
prepareStep forces the skill tool on the invoking turn. Nothing is pasted
into the prompt; the loaded instructions stay in the conversation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The composer shows this conversation's skills, never attaches, and turns `/` off in test chats

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts:200` (`Conversation.metadata`)
- Modify: `apps/web/components/platform/chat/ChatInput.tsx`
- Modify: `apps/web/components/platform/chat/SkillChip.tsx` (doc comments only)
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`: around lines 97-140, and the `ChatInput` renders at lines 451, 455, 464
- Test: `apps/web/components/platform/chat/chatInputSkillTrigger.test.tsx`

**Interfaces:**
- Consumes: `metadata.invokedSkills` and `metadata.testSkillInstallId` on the conversation (Tasks 7 and 8), and `PATCH /conversations/:id` with `invokedSkills` (Task 7).
- Produces three new `ChatInput` props:
  - `invokedSkills?: Array<{ skillId: string; installId: string; name: string }>`;
  - `onRemoveInvokedSkill?: (skillId: string) => void`;
  - `isTestChat?: boolean`.

  Also the exported constant `TEST_CHAT_SKILL_HINT`.

- [ ] **Step 1: Update the tests**

In `apps/web/components/platform/chat/chatInputSkillTrigger.test.tsx`:
- In the `vi.mock('sonner', ...)` factory, replace `info: vi.fn()` with `info: (m: string) => toastInfo(m)`, and add `const toastInfo = vi.fn();` next to `toastError`.
- In `describe('ChatInput skill attach')`:
  - replace the first test with the one below;
  - in `'strips the typed "/query" from the draft on pick'`, delete the `attachSkillToAgent.mockResolvedValue(undefined);` line;
  - delete every other test in that describe that asserts on `attachSkillToAgent` or its toasts.

```ts
    it('never attaches the picked skill to the agent — it only becomes a draft chip', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/blog');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(screen.getByText('Blog Formatter')).toBeTruthy());
        expect(attachSkillToAgent).not.toHaveBeenCalled();
    });
```

- Add after it:

```ts
describe('ChatInput conversation skills', () => {
    const INVOKED = { skillId: 'skill-9', installId: 'install-9', name: 'UGC Ad Production' };

    it('shows a chip for each skill turned on in this conversation, and X removes it from the conversation', async () => {
        const onRemove = vi.fn();
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" invokedSkills={[INVOKED]} onRemoveInvokedSkill={onRemove} />);

        expect(screen.getByText('UGC Ad Production')).toBeTruthy();
        await userEvent.click(screen.getByTitle('Dismiss'));
        expect(onRemove).toHaveBeenCalledWith('skill-9');
    });

    it('shows one chip when a draft pick is already on in the conversation', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" invokedSkills={[{ skillId: 'skill-1', installId: 'install-1', name: 'Blog Formatter' }]} />);
        await type('/blog');
        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(screen.getAllByText('Blog Formatter')).toHaveLength(1));
    });

    it('sends the draft picks with the message as skillsUsed', async () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} agentId="agent-1" />);
        const box = await type('/blog');
        await userEvent.click(screen.getByText('slash-palette'));
        await userEvent.type(box, 'write me an intro{enter}');

        await waitFor(() => expect(onSend).toHaveBeenCalled());
        expect(onSend.mock.calls[0][2]).toEqual([{ id: 'skill-1', name: 'Blog Formatter' }]);
    });
});

describe('ChatInput in a Test-in-chat conversation', () => {
    it('does not open the skill palette on "/", and says why', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        await type('/');

        expect(screen.queryByText('slash-palette')).toBeNull();
        expect(toastInfo).toHaveBeenCalledWith('Test chats run one skill. Start a normal chat to combine skills.');
    });

    it('shows the hint once per draft, not once per keystroke', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        await type('/abc');
        expect(toastInfo).toHaveBeenCalledTimes(1);
    });

    it('does not advertise "/" or offer "Use skill"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        expect(screen.queryByPlaceholderText(/\/ for skills/)).toBeNull();
        await openAddMenu();
        expect(screen.queryByText('Use skill')).toBeNull();
    });
});
```

Run: `pnpm --filter @serverless-saas/web test chatInputSkillTrigger`
Expected: FAIL. The component still attaches on pick, doesn't know `invokedSkills` or `isTestChat`, and doesn't show the hint.

- [ ] **Step 2: Extend the conversation type**

In `apps/web/components/platform/chat/types.ts`, replace line 200 (`metadata?: { folderScope?: ...; allowMode?: ... } | null;`) with:

```ts
    metadata?: {
        folderScope?: { prefix: string };
        allowMode?: 'ask' | 'auto';
        /** Set on a Test-in-chat conversation, which runs exactly this one skill. */
        testSkillInstallId?: string;
        /** Skills turned on in this conversation with "/". Never attached to the agent. */
        invokedSkills?: Array<{ installId: string; skillId: string; name: string }>;
    } | null;
```

- [ ] **Step 3: Rework `ChatInput.tsx`**

In `apps/web/components/platform/chat/ChatInput.tsx`:

1. **Constant.** Below the imports, add:
   ```ts
   export const TEST_CHAT_SKILL_HINT = "Test chats run one skill. Start a normal chat to combine skills.";
   ```
2. **Props.** In `ChatInputProps`, replace the `agentId` doc comment and add three props:
   ```ts
       /** Gates the "/" palette: the public widget renders this composer with
        *  no agent and must not list the tenant's skill library. A "/" pick
        *  applies to this conversation only — it never attaches to the agent. */
       agentId?: string;
       /** Skills turned on in this conversation with "/", read from the
        *  conversation's metadata so they survive a reload. */
       invokedSkills?: Array<{ skillId: string; installId: string; name: string }>;
       /** Removes one skill from this conversation — never from the agent. */
       onRemoveInvokedSkill?: (skillId: string) => void;
       /** A Test-in-chat conversation runs exactly one skill, so "/" is off. */
       isTestChat?: boolean;
   ```
   Destructure `invokedSkills`, `onRemoveInvokedSkill` and `isTestChat` alongside `agentId` in the component signature.
3. **Draft state.** Replace the `pickedSkills` comment with:
   ```ts
       // Skills picked via "/" in this draft. Sent with the message as
       // skillsUsed; the orchestrator turns them on for this conversation.
   ```
4. **Delete the attached-skills query.** Delete `dismissedAttachedIds` and its comment, `const queryClient = useQueryClient();`, and the attached-skills comment, `useQuery` and `attachedSkills` (lines 164-186). In their place add:
   ```ts
       // A skill already on in this conversation that is also picked in the
       // draft shows once, as the draft chip.
       const visibleInvokedSkills = (invokedSkills ?? []).filter(s => !pickedSkills.some(p => p.id === s.skillId));
       const testChatHintShownRef = useRef(false);
   ```
5. **Delete the attach handler.** Delete the `// "/" attaches an installed skill ...` comment block and the whole `handleAttachSkill` function.
6. **Gate `/` in test chats.** In `openPalette`, directly after `if (mode === 'slash' && !agentId) return;`, add:
   ```ts
           // A Test-in-chat conversation runs exactly one skill; combining
           // skills there defeats the test. Say so once per draft rather than
           // opening nothing silently.
           if (mode === 'slash' && isTestChat) {
               if (!testChatHintShownRef.current) {
                   toast.info(TEST_CHAT_SKILL_HINT);
                   testChatHintShownRef.current = true;
               }
               return;
           }
   ```
   In `handleSend`, next to each `setPickedSkills([]);`, add `testChatHintShownRef.current = false;`.
7. **Picking no longer attaches.** In the `SlashPalette` `onSelect`:
   - delete `void handleAttachSkill(skill);`;
   - replace its comment with `// Strip the typed "/query" trigger text — the pick becomes a draft chip below, sent with the message as skillsUsed.`
8. **Hide `/` in test chats.** Three places:
   - the `MentionPalette` prop: `onSwitchToSlash={agentId && !isTestChat ? () => switchPalette('slash') : undefined}`;
   - the textarea placeholder: `placeholder={agentId && !isTestChat ? "Ask anything, / for skills, @ for AI employees..." : "Ask anything, @ for AI employees..."}`;
   - the "Use skill" menu item: `{agentId && !isTestChat && (`.
9. **Render the conversation's chips.** Replace the `{attachedSkills.length > 0 && (...)}` block with:
   ```tsx
                       {visibleInvokedSkills.length > 0 && (
                           <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                               {visibleInvokedSkills.map(skill => (
                                   <SkillChip
                                       key={skill.installId}
                                       skill={{ id: skill.skillId, name: skill.name }}
                                       onRemove={() => onRemoveInvokedSkill?.(skill.skillId)}
                                   />
                               ))}
                           </div>
                       )}
   ```
10. **Imports.** Delete the `attachSkillToAgent` import. Then remove `useQuery`, `useQueryClient`, `api` and `ApiError` from their imports if nothing else in the file still uses them; check with `grep -n "useQuery\|useQueryClient\|api\.\|ApiError" apps/web/components/platform/chat/ChatInput.tsx`.

- [ ] **Step 4: Update the chip's comments**

In `apps/web/components/platform/chat/SkillChip.tsx`:
- Replace the prop comment with `// Only id (icon seed) and name are rendered.`
- Replace the component doc comment with:

```ts
/**
 * A skill in the composer: either a "/" pick in this draft, or a skill already
 * turned on in this conversation. Removing it never touches the agent — a
 * draft chip is dropped from the message, and a conversation chip is turned
 * off for this conversation only.
 */
```

- [ ] **Step 5: Wire the chat page**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`:
- In the `allowModeProps` object, replace its comment about `/` attaching to the agent with `// agentId gates the "/" palette (the public widget has no agent); a "/" pick applies to this conversation only.`
- After `allowModeProps`, add:

```ts
    // "/" skills live on the conversation, not the agent: a chip's X turns the
    // skill off for this conversation only. Same server-side storage and
    // invalidation as folderScope and allowMode above.
    const invokedSkills = selectedConversation?.metadata?.invokedSkills ?? [];
    const setInvokedSkills = useMutation({
        mutationFn: (next: Array<{ installId: string; skillId: string; name: string }>) =>
            api.patch(`/api/v1/conversations/${conversationId}`, { invokedSkills: next.length > 0 ? next : null }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
        },
        onError: () => toast.error('Could not turn that skill off'),
    });
    const skillProps = {
        invokedSkills,
        isTestChat: !!selectedConversation?.metadata?.testSkillInstallId,
        onRemoveInvokedSkill: (skillId: string) =>
            setInvokedSkills.mutate(invokedSkills.filter(s => s.skillId !== skillId)),
    };
```

- Add `{...skillProps}` next to `{...allowModeProps}` in each of the three `ChatInput` renders inside a conversation (lines 451, 455, 464). The new-chat composer around line 536 has no conversation yet and gets no `skillProps`.

The orchestrator saves a newly invoked skill on the send turn, and `useChatStream.ts` already invalidates `['conversation', conversationId]` when the stream ends (lines 243-244). So a sent pick reappears as a conversation chip without further wiring.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @serverless-saas/web test chat`
Expected: PASS, including the new tests in `chatInputSkillTrigger.test.tsx` and the existing `chatInputAllowMode` and `chatInputFolderScope` tests.

Run: `pnpm --filter @serverless-saas/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/components/platform/chat/ChatInput.tsx \
        apps/web/components/platform/chat/SkillChip.tsx apps/web/components/platform/chat/chatInputSkillTrigger.test.tsx \
        "apps/web/app/[tenant]/dashboard/chat/page.tsx"
git commit -m "feat(web): \"/\" turns a skill on for the conversation; the composer shows only those

The composer no longer attaches to the agent or lists its standing skills,
and \"/\" is off in Test-in-chat conversations with a hint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The agent page lists attached skills and can detach them

**Files:**
- Modify: `apps/web/components/platform/skills/actions.ts` (add `detachSkillFromAgent`) and `actions.test.ts`
- Modify: `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection.tsx`
- Create: `apps/web/components/platform/skills/AgentSkillSection.test.tsx`

Before creating the test, check where the web vitest config picks up test files. If its `include` doesn't cover `app/**`, keep the test under `components/` and import the component by its `app/` path.

**Interfaces:**
- Consumes: `GET /agents/:agentId/skills`, which never returns `default` (Task 4); `DELETE /agents/:agentId/skills/:skillId`, which already exists and archives the row; `POST` reactivation on re-attach (Task 4).
- Produces: `detachSkillFromAgent(agentId: string, agentSkillId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/components/platform/skills/actions.test.ts`:
- add `detachSkillFromAgent` to the import from `./actions`;
- add:

```ts
describe("detachSkillFromAgent", () => {
    beforeEach(() => vi.clearAllMocks());

    it("DELETEs the agent's skill row by its id", async () => {
        vi.mocked(api.del).mockResolvedValue(undefined as never);
        await detachSkillFromAgent("agent-1", "row-1");
        expect(api.del).toHaveBeenCalledWith("/api/v1/agents/agent-1/skills/row-1");
    });
});
```

Create `apps/web/components/platform/skills/AgentSkillSection.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
    api: { get: vi.fn(async () => ({ data: [{ id: "row-1", name: "ugc-ads-production" }] })) },
}));
const detachSkillFromAgent = vi.fn(async () => undefined);
vi.mock("@/components/platform/skills/actions", () => ({
    detachSkillFromAgent: (...args: unknown[]) => detachSkillFromAgent(...(args as [])),
}));
vi.mock("@/components/platform/skills/AttachSkillPicker", () => ({ AttachSkillPicker: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { AgentSkillSection } from "@/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderSection() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <AgentSkillSection agentId="agent-1" isOwner brandingEnabled={false} tenantSlug="t" agent={undefined} isLoading={false} />
        </QueryClientProvider>,
    );
}

describe("AgentSkillSection", () => {
    it("lists the skills attached to the agent", async () => {
        renderSection();
        await waitFor(() => expect(screen.getByText("ugc-ads-production")).toBeTruthy());
    });

    it("detaches a skill by its row id", async () => {
        renderSection();
        await waitFor(() => screen.getByText("ugc-ads-production"));
        await userEvent.click(screen.getByRole("button", { name: /detach ugc-ads-production/i }));
        await waitFor(() => expect(detachSkillFromAgent).toHaveBeenCalledWith("agent-1", "row-1"));
    });
});
```

Run: `pnpm --filter @serverless-saas/web test AgentSkillSection actions`
Expected: FAIL. `detachSkillFromAgent` doesn't exist, and the section renders no list.

- [ ] **Step 2: Add the action**

Append to `apps/web/components/platform/skills/actions.ts`:

```ts
/**
 * Detaches a skill from an agent: archives its agent_skills row. The install
 * stays in the tenant's library, and attaching it again reactivates the same
 * row (see the API's attach route).
 */
export async function detachSkillFromAgent(agentId: string, agentSkillId: string): Promise<void> {
    await api.del(`/api/v1/agents/${agentId}/skills/${agentSkillId}`);
}
```

- [ ] **Step 3: List and detach on the agent page**

In `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection.tsx`, add these imports:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { detachSkillFromAgent } from "@/components/platform/skills/actions";
```

Inside the component, after the `attachOpen` state, add:

```ts
    // The agent's standing skills — always available to it, loaded when
    // relevant. The composer never shows these; this page is where they live.
    const queryClient = useQueryClient();
    const { data: attachedData } = useQuery({
        queryKey: ["agent-skills", agentId],
        queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>(`/api/v1/agents/${agentId}/skills`),
        enabled: !!agentId,
    });
    const attached = attachedData?.data ?? [];
    const detach = useMutation({
        mutationFn: (agentSkillId: string) => detachSkillFromAgent(agentId, agentSkillId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] }),
        onError: () => toast.error("Could not detach that skill"),
    });
```

Replace the "Skills library" card's subtitle, `Attach an installed skill package to this agent.`, with `Skills this agent can use in every conversation. It loads one when it's relevant.`

Directly after that card's header row `</div>`, and still inside `CardContent`, add:

```tsx
                    {attached.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No skills attached yet.</p>
                    ) : (
                        <ul className="space-y-2">
                            {attached.map((skill) => (
                                <li key={skill.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-4 py-2">
                                    <span className="text-sm font-medium">{skill.name}</span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`Detach ${skill.name}`}
                                        disabled={detach.isPending}
                                        onClick={() => detach.mutate(skill.id)}
                                    >
                                        Detach
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
```

Replace the `AttachSkillPicker`'s `onAttached` with:

```tsx
                onAttached={() => queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] })}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @serverless-saas/web test AgentSkillSection actions`
Expected: PASS.

Run: `pnpm --filter @serverless-saas/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/skills/actions.ts apps/web/components/platform/skills/actions.test.ts \
        apps/web/components/platform/skills/AgentSkillSection.test.tsx \
        "apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection.tsx"
git commit -m "feat(web): agent page lists attached skills and can detach them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## PR 2 — merge only after PR 1 is deployed everywhere and its checks pass

### Task 12: Migration B — delete the `default` rows and swap the last constraint

**Files:**
- Modify: `products/agent-platform/packages/schema/conversations.ts` (the `agentSkills` table's third argument)
- Create: `packages/foundation/database/migrations/0092_<generated-name>.sql`, plus its generated snapshot and journal entry

**Interfaces:**
- Consumes: PR 1 deployed. Old code must no longer be running anywhere, because it reads `default` rows.
- Produces:
  - no `default` rows;
  - installed rows renamed to their manifest name;
  - the constraint `agent_skills_agent_id_tenant_id_name_version_unique` gone;
  - a new partial unique index `agent_skills_agent_authored_name_active_unique` on `(agent_id, tenant_id, name)` where `install_id is null and status = 'active'`.

- [ ] **Step 1: Swap the constraint in the schema**

In the `agentSkills` table's third argument, replace `uniqueSkillVersion: unique().on(t.agentId, t.tenantId, t.name, t.version),` with:

```ts
  // A hand-authored skill (no install) is identified by its name. Active rows
  // only, so a detached row never blocks re-creating it.
  activeAuthoredNameUnique: uniqueIndex('agent_skills_agent_authored_name_active_unique')
    .on(t.agentId, t.tenantId, t.name)
    .where(sql`install_id is null and status = 'active'`),
```

Remove `unique` from the `drizzle-orm/pg-core` import if nothing else in the file uses it.

- [ ] **Step 2: Generate**

Run: `pnpm --filter @serverless-saas/database db:generate`

Expected: a new `0092_*.sql` containing `ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_agent_id_tenant_id_name_version_unique";` and `CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_agent_authored_name_active_unique" ... WHERE install_id is null and status = 'active';`, and nothing else. Anything else is schema drift from someone else's work: stop and report it.

- [ ] **Step 3: Order the statements: data, then the drop, then the rename, then the index**

Amended during Task 4's review. The old `(agent_id, tenant_id, name, version)` constraint also covers archived
rows, so renaming an installed row to its manifest name while that constraint exists can collide with an
archived duplicate. Drop the constraint BEFORE renaming. The generated `DROP CONSTRAINT` statement moves to
sit between the delete and the rename, below.

At the very top of the generated `0092_*.sql`, above the generated `DROP CONSTRAINT`, insert the copy and delete
statements below. Then move the generated `DROP CONSTRAINT` line to directly after the `DELETE`. The rename and
archive statements follow it, and the generated `CREATE UNIQUE INDEX` stays last:

```sql
-- Any agent onboarded between 0091 and the PR 1 deploy got a 'default' row
-- but no system_prompt. Copy those before the rows go.
UPDATE "agents" a SET "system_prompt" = s."system_prompt"
FROM (
  SELECT DISTINCT ON (agent_id) agent_id, system_prompt
  FROM "agent_skills"
  WHERE name = 'default' AND status = 'active'
  ORDER BY agent_id, created_at DESC
) s
WHERE s.agent_id = a.id AND a.system_prompt IS NULL;
--> statement-breakpoint
-- The base prompt now lives on agents.system_prompt. No table references
-- agent_skills.id, so these rows can go.
DELETE FROM "agent_skills" WHERE name = 'default';
--> statement-breakpoint
-- (The generated `ALTER TABLE "agent_skills" DROP CONSTRAINT
-- "agent_skills_agent_id_tenant_id_name_version_unique";` goes HERE, followed by
-- its `--> statement-breakpoint`.)
--
-- Installed rows take their manifest name. Task 4's reactivation keeps a row's
-- existing name, so this is where names are normalised. The old constraint is
-- already gone at this point; the NOT EXISTS guard stays as a belt-and-braces
-- skip for any row that would still clash on the same name and version.
UPDATE "agent_skills" s SET "name" = sv.manifest->>'name', "updated_at" = now()
FROM "skill_installs" si
JOIN "skill_versions" sv ON sv.skill_id = si.skill_id AND sv.version = si.installed_version
WHERE s.install_id = si.id AND s.status = 'active'
  AND coalesce(sv.manifest->>'name', '') <> '' AND s.name <> sv.manifest->>'name'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_skills" o
    WHERE o.agent_id = s.agent_id AND o.tenant_id = s.tenant_id
      AND o.name = sv.manifest->>'name' AND o.version = s.version AND o.id <> s.id
  );
--> statement-breakpoint
-- The new index allows one active hand-authored skill per name. Keep the
-- highest version where more than one is active.
UPDATE "agent_skills" SET "status" = 'archived', "updated_at" = now()
WHERE "id" IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY agent_id, tenant_id, name ORDER BY version DESC, created_at DESC
    ) AS rn
    FROM "agent_skills"
    WHERE install_id IS NULL AND status = 'active'
  ) d
  WHERE d.rn > 1
);
--> statement-breakpoint
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @serverless-saas/agent-schema build && pnpm --filter @serverless-saas/agent-api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/schema/conversations.ts packages/foundation/database/migrations
git commit -m "feat(schema): delete the 'default' agent_skills rows and key hand-authored skills on name

Migration 0092. Run only after the PR 1 code is deployed everywhere.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Remove the transition guards

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts` (`fetchAttachedSkills`) and `usage.test.ts`
- Modify: `products/agent-platform/packages/api/routes/agent-skills.ts` and its test
- Modify: `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts` and its test

**Interfaces:**
- Consumes: migration 0092 (Task 12) applied, so no `default` rows exist.
- Produces: no code anywhere special-cases the name `default`.

- [ ] **Step 1: Update the tests to the post-migration world**

- In `apps/agent-orchestrator/src/usage.test.ts`, delete the test `'excludes the default persona row in the query itself'`.
- In `products/agent-platform/packages/api/__tests__/agent-skills.test.ts`:
  - delete the test `"does not count the agent's 'default' row, which is its base prompt"`;
  - replace the GET test with:

```ts
    it('lists the attached skills', async () => {
        mockDb({ list: [{ id: 'b', name: 'bid-writer' }] });
        const res = await request('GET', undefined, 'read');
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual([{ id: 'b', name: 'bid-writer' }]);
    });
```

- In `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`:
  - rename the test `"doesn't count the agent's 'default' row or this install toward the cap"` to `"doesn't count this install toward its own cap"`;
  - change its `expect(count).toContain("s.name <> 'default'")` to `expect(count).not.toContain("'default'")`.

- [ ] **Step 2: Run to verify the worker test fails**

Run: `pnpm --filter @serverless-saas/agent-worker-handlers test skillImport`
Expected: FAIL, because the count SQL still contains `'default'`.

- [ ] **Step 3: Remove the guards**

- `apps/agent-orchestrator/src/usage.ts`, `fetchAttachedSkills`:
  - delete ` AND name != 'default'` from the query;
  - in the doc comment, delete `(excluding "default" — the onboarding bootstrap row holding the agent's base persona, not a real skill; read separately by fetchAgentPersonaPrompt)`.
- `products/agent-platform/packages/api/routes/agent-skills.ts`:
  - in GET, replace the TRANSITION comment and `data.filter(...)` with `return c.json({ data });`;
  - in POST, delete `s.name !== 'default' && ` from the `others` filter, and delete the TRANSITION sentence from its comment.
- `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts`:
  - delete ` AND s.name <> 'default'` from the count SQL;
  - delete the TRANSITION sentence from the comment above it.

Then:

```bash
grep -rn "'default'" apps/agent-orchestrator/src/usage.ts products/agent-platform/packages/api/routes/agent-skills.ts products/agent-platform/packages/worker-handlers/handlers/skillImport.ts
```

Expected: no output.

- [ ] **Step 4: Run the suites**

```bash
pnpm --filter agent-orchestrator test
pnpm --filter @serverless-saas/agent-api test
pnpm --filter @serverless-saas/agent-worker-handlers test
```

Expected: all pass, except the two pre-existing orchestrator failures.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts \
        products/agent-platform/packages/api/routes/agent-skills.ts products/agent-platform/packages/api/__tests__/agent-skills.test.ts \
        products/agent-platform/packages/worker-handlers/handlers/skillImport.ts products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts
git commit -m "refactor: stop special-casing the 'default' agent_skills row

Migration 0092 deleted those rows, so the transition guards go.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Checks after deploy (for the user; no subagent can run these)

**After PR 1 is deployed and `0091` is applied on dev:**

- [ ] 1. `SELECT count(*) FROM agents WHERE status <> 'retired' AND system_prompt IS NOT NULL;` returns 52. `Producer` in `Test team` is null.
- [ ] 2. Olmo in `yash-test` has one active UGC row; the other is `archived`.
- [ ] 3. A fresh chat's composer shows no chips. In particular no `default` chip, and none of Olmo's attached skills.
- [ ] 4. Pick a skill with `/` and send. The chip shows before sending, and the reply's tool trace shows a `skill` call first. After a reload of that conversation the chip is still there. The skill-used chip still appears on the message where the skill was invoked. A new conversation shows no chip, and the skill is not on the agent page.
- [ ] 5. The X on that chip turns it off, and it stays off after a reload.
- [ ] 6. In a Test-in-chat conversation, typing `/` shows `Test chats run one skill. Start a normal chat to combine skills.` and opens nothing.
- [ ] 7. The agent page lists Olmo's attached skills, with no `default`. Detach removes one. Attaching it again from the library brings the same row back (`status` returns to `active`; the row count doesn't grow).
- [ ] 8. Onboard a fresh tenant. Its agents have `system_prompt` set and it has zero `default` rows.

**After PR 2 is deployed and `0092` is applied:**

- [ ] 9. `SELECT count(*) FROM agent_skills WHERE name = 'default';` returns 0, and Olmo still answers with its own prompt.
