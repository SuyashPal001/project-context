# Skill Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Skills dashboard's "Import skill" entry point with "Create skill" — the user describes what a skill should teach an agent, the orchestrator streams back a generated SKILL.md, and saving it produces a real installable skill package.

**Architecture:** Generation runs in `apps/agent-orchestrator` (GCP VM, port 3001) as a new SSE route that calls the inference gateway and debits credits like a chat turn. Saving posts a fourth source variant — `{ type: 'authored', body }` — to the existing `POST /api/v1/skills`, which enqueues `skill.import` exactly as today; the worker gains a ten-line branch that treats the body as a one-file package. No new S3 code, no duplicated manifest parser. Import's backend stays whole; only its UI leaves the page.

**Tech Stack:** Hono (orchestrator + API Lambda), Vercel AI SDK v6 (`streamText`) via `@ai-sdk/openai-compatible`, Drizzle + Postgres, Next.js App Router + TanStack Query + shadcn/ui, Vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-09-05-skill-authoring-design.md`

## Global Constraints

- Package scope is `@serverless-saas/*`. Agent-platform tables come from `@serverless-saas/agent-schema/skills`.
- Every DB query filters by `tenantId`. `tenantId` comes from the request context (API) or the JWT's `custom:tenantId` claim (orchestrator) — **never** from a request body.
- Orchestrator source files use ESM with explicit `.js` import suffixes (e.g. `import { validateToken } from '../auth.js'`). API and worker packages do not.
- Web API calls put `/api/v1` in the path, never in the base URL.
- SKILL.md body cap: **65,536 bytes** (`z.string().min(1).max(65_536)`).
- Generation model: `platformModel` from `apps/agent-orchestrator/src/mastra/model.ts` (inference gateway on :4001). Never `llm/quickCall.ts`.
- Credit debit sentinel: `agentId: 'skill-generator'`, `messageId: 'skillgen:<uuid>'`.
- New skills save as `visibility: 'private'`. No publish toggle in the dialog.
- Test runner in every package: `pnpm test` → `vitest run`.
- Commit style: Conventional Commits, body explains *why*. Sign with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw
  ```
- `.gitignore` contains a blanket `*.md` at line 52 — committing any Markdown file needs `git add -f`.

---

### Task 1: `authored` source type — schema, migration, API route

Adds the fourth source variant end-to-end on the write side. After this task the API accepts an authored body and enqueues it; the worker doesn't understand it yet (Task 2), so a version created here would sit `pending`. That's fine — nothing calls it until Task 5.

**Files:**
- Modify: `products/agent-platform/packages/schema/skills.ts:7` (the `skillSourceTypeEnum` line)
- Create: `packages/foundation/database/migrations/00XX_skill_authored_source.sql` (number it one above the highest existing file in that directory)
- Modify: `packages/foundation/database/migrations/meta/_journal.json`
- Modify: `products/agent-platform/packages/api/routes/skills.ts:17-21` (`sourceSchema`), `:81` (`sourceRef` in `createVersionAndEnqueue`)
- Test: `products/agent-platform/packages/api/__tests__/skills.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the wire shape `{ type: 'authored', body: string }` accepted by `POST /api/v1/skills` and published to SQS as `{ type: 'skill.import', tenantId, skillId, skillVersionId, version, source }`. Task 2 consumes that payload; Task 5 produces it from the browser.

- [ ] **Step 1: Write the failing tests**

Append to `products/agent-platform/packages/api/__tests__/skills.test.ts`, inside the existing `describe('POST /skills', ...)` block (it already has a `beforeEach` that clears mocks and sets `SQS_PROCESSING_QUEUE_URL`):

```ts
  it('accepts an authored source and enqueues it with sourceType authored', async () => {
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          if (table === skills) return [{ id: SKILL_ID, ...data }];
          if (table === skillVersions) return [{ id: 'version-1', ...data }];
          return [{ id: 'audit-1' }];
        },
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bid Writer',
        source: { type: 'authored', body: '---\nname: bid-writer\ndescription: Writes bids\n---\n\nDo the thing.' },
      }),
    });

    expect(res.status).toBe(202);
    expect(publishToQueueMock).toHaveBeenCalledTimes(1);
    const [, message] = publishToQueueMock.mock.calls[0];
    expect(message.type).toBe('skill.import');
    expect(message.source).toEqual({
      type: 'authored',
      body: '---\nname: bid-writer\ndescription: Writes bids\n---\n\nDo the thing.',
    });
  });

  // An authored version has no external source to point back at — unlike a zip
  // (fileKey), a URL, or owner/repo@ref — so sourceRef stays null rather than
  // duplicating the body into a text column the UI never reads.
  it('stores a null sourceRef for an authored version', async () => {
    const inserted: Record<string, unknown>[] = [];
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        if (table === skillVersions) inserted.push(data);
        return {
          returning: async () => {
            if (table === skills) return [{ id: SKILL_ID, ...data }];
            if (table === skillVersions) return [{ id: 'version-1', ...data }];
            return [{ id: 'audit-1' }];
          },
          catch: () => {},
        };
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bid Writer',
        source: { type: 'authored', body: '---\nname: bid-writer\ndescription: d\n---\n\nBody.' },
      }),
    });

    expect(inserted[0].sourceType).toBe('authored');
    expect(inserted[0].sourceRef).toBeNull();
  });

  it('rejects an authored body over 64KB', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Huge', source: { type: 'authored', body: 'x'.repeat(65_537) } }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects an empty authored body', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty', source: { type: 'authored', body: '' } }),
    });

    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/api && pnpm test -- skills.test.ts`
Expected: the four new tests FAIL — the first two with a 400 (`VALIDATION_ERROR`, `invalid_union_discriminator`) instead of 202, because `sourceSchema` has no `authored` member. The two rejection tests may pass accidentally; they exist to pin the boundary once `authored` is valid.

- [ ] **Step 3: Add `authored` to the Drizzle enum**

In `products/agent-platform/packages/schema/skills.ts`, change:

```ts
export const skillSourceTypeEnum = pgEnum('skill_source_type', ['zip', 'github', 'url']);
```

to:

```ts
// 'authored' is a skill written in the app (agent-generated SKILL.md), not
// imported from a package — it carries its content in the queue message and
// has no external source to point back at, so its sourceRef is null.
export const skillSourceTypeEnum = pgEnum('skill_source_type', ['zip', 'github', 'url', 'authored']);
```

- [ ] **Step 4: Write the migration by hand**

Do NOT run `drizzle-kit generate` for this one — it regenerates a full snapshot across the whole schema, and this worktree's `_journal.json` is already carrying an unrelated in-flight migration on `main`. Write the file directly.

First find the next number:

```bash
ls packages/foundation/database/migrations/*.sql | tail -3
```

Create `packages/foundation/database/migrations/00XX_skill_authored_source.sql` (with `00XX` replaced by the next number):

```sql
-- Postgres requires ADD VALUE to run outside a transaction block in older
-- versions; IF NOT EXISTS makes the statement safe to re-apply.
ALTER TYPE "public"."skill_source_type" ADD VALUE IF NOT EXISTS 'authored';
```

Append the matching entry to the `entries` array in `packages/foundation/database/migrations/meta/_journal.json`, copying the shape of the last entry and incrementing `idx`:

```json
    {
      "idx": <next idx>,
      "version": "7",
      "when": <current epoch millis>,
      "tag": "00XX_skill_authored_source",
      "breakpoints": true
    }
```

- [ ] **Step 5: Add the `authored` variant to the API route**

In `products/agent-platform/packages/api/routes/skills.ts`, extend `sourceSchema` (line ~17):

```ts
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('zip'), fileKey: z.string().min(1).max(512) }),
  z.object({ type: z.literal('github'), owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), ref: z.string().min(1).max(100) }),
  z.object({ type: z.literal('url'), url: z.string().url().max(2048) }),
  // Written in-app rather than imported: the SKILL.md body travels in the
  // request and on to the import worker, which is why it's capped at 64KB —
  // an SQS message body maxes out at 256KB and this has to fit inside one.
  z.object({ type: z.literal('authored'), body: z.string().min(1).max(65_536) }),
]);
```

Then in `createVersionAndEnqueue` (line ~81), extend the `sourceRef` ternary chain:

```ts
    sourceRef: source.type === 'zip' ? source.fileKey
      : source.type === 'url' ? source.url
      : source.type === 'github' ? `${source.owner}/${source.repo}@${source.ref}`
      : null,
```

Nothing else in either POST handler changes: `isOwnUploadKey` is already gated on `source.type === 'zip'`, and the audit row's `sourceType` field picks up `'authored'` for free.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/api && pnpm test -- skills.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @serverless-saas/agent-api type-check` (from the repo root)
Expected: no errors. If `type-check` isn't a script in that package, run `pnpm --filter @serverless-saas/agent-api exec tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add products/agent-platform/packages/schema/skills.ts \
        products/agent-platform/packages/api/routes/skills.ts \
        products/agent-platform/packages/api/__tests__/skills.test.ts \
        packages/foundation/database/migrations/
git commit -m "feat(skills): accept an authored SKILL.md as a skill source

Skills could only be created from a package that already existed — a zip,
a GitHub repo, a URL. A skill written in the app has no such source, so it
carries its SKILL.md body in the request instead and leaves sourceRef null.
Capped at 64KB so the body still fits in the SQS message the import worker
receives.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 2: Import worker handles the `authored` source

Makes an authored version actually reach `ready`. After this task, a skill created via `curl` against the API is a real, installable skill — the whole backend is done.

**Files:**
- Modify: `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts:22-25` (the `SkillImportSource` union), `:41-68` (`extractForSource`)
- Test: `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`

**Interfaces:**
- Consumes: the `{ type: 'authored', body: string }` source shape from Task 1.
- Produces: nothing new — an authored version lands in exactly the same `ready`/`failed` states, with the same `manifest` jsonb (`{ name, description, ...frontmatter, body }`) and the same `skill-packages/{skillId}/{version}/SKILL.md` S3 key as an imported one.

- [ ] **Step 1: Write the failing tests**

Open `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts` and read the existing tests first — reuse whatever `beforeEach`, S3 mock reset, and success-assertion helpers are already there rather than inventing new ones. Add:

```ts
  it('writes a single SKILL.md and reaches ready for an authored source', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    const body = '---\nname: bid-writer\ndescription: Writes bids for RFPs\n---\n\nAlways open with the client name.';
    await handleSkillImport({
      tenantId: 'tenant-1',
      skillId: 'skill-1',
      skillVersionId: 'version-1',
      version: 1,
      source: { type: 'authored', body },
    });

    // Exactly one object written, at the version's prefix, and it is SKILL.md.
    const puts = s3SendMock.mock.calls
      .map(([command]) => (command as { input?: { Key?: string; Body?: unknown } }).input)
      .filter((input) => typeof input?.Key === 'string' && input.Key.includes('skill-packages/'));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.Key).toBe('skill-packages/skill-1/1/SKILL.md');
    expect(String(puts[0]!.Body)).toBe(body);

    // The version row is marked ready, with the parsed manifest.
    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'ready'");
  });

  it('never calls S3 GetObject or the network for an authored source', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1',
      skillId: 'skill-1',
      skillVersionId: 'version-1',
      version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: d\n---\n\nBody.' },
    });

    expect(safeExtractSkillZipMock).not.toHaveBeenCalled();
  });

  it('fails an authored version whose body has no frontmatter', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1',
      skillId: 'skill-1',
      skillVersionId: 'version-1',
      version: 1,
      source: { type: 'authored', body: 'Just some prose with no frontmatter block.' },
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'failed'");
    const params = dbMock.execute.mock.calls.flatMap(([q]) => sqlParams(q));
    expect(params.some((p) => String(p).includes('frontmatter'))).toBe(true);
  });
```

If the existing failure tests in this file assert failure reasons differently (they were written against `SkillManifestError`'s sanitised message), match their assertion style instead of the last two lines above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/worker-handlers && pnpm test -- skillImport.test.ts`
Expected: FAIL — `extractForSource` falls through its `zip`/`github` branches to the URL branch and calls `fetchPublicUrl(undefined)`.

- [ ] **Step 3: Extend the source union and `extractForSource`**

In `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts`, extend the union (line ~22):

```ts
export type SkillImportSource =
  | { type: 'zip'; fileKey: string }
  | { type: 'github'; owner: string; repo: string; ref: string }
  | { type: 'url'; url: string }
  | { type: 'authored'; body: string };
```

Add the branch at the top of `extractForSource`, before the `zip` branch:

```ts
  // Authored skills arrive with their SKILL.md inline — nothing to download,
  // unpack, or defend against. They deliberately still flow through this
  // handler rather than being written straight from the API route: manifest
  // parsing, the S3 layout, and the pending→ready/failed transitions all live
  // here, and a second copy of that in the Lambda could drift from the one
  // the runtime actually trusts.
  if (source.type === 'authored') {
    return {
      entries: [{ fileName: 'SKILL.md', buffer: Buffer.from(source.body, 'utf8') }],
      manifestSource: source.body,
      skipped: [],
    };
  }
```

The rest of `handleSkillImport` is untouched — it already parses `manifestSource`, writes every entry to S3, and flips the version row.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/worker-handlers && pnpm test`
Expected: PASS, whole file including the pre-existing zip/github/url tests.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/worker-handlers/handlers/skillImport.ts \
        products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts
git commit -m "feat(skills): import an authored SKILL.md as a one-file package

An authored skill has its content in hand already, so extraction is a
no-op that hands back a single SKILL.md entry. Routing it through this
handler rather than writing S3 from the API route keeps manifest parsing
and the version state machine in one place, where the runtime already
trusts them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 3: Skill-generation prompt

The prompt is its own file with its own test because it is the thing that decides whether generated skills are usable or garbage — and because Task 4's route test shouldn't have to carry a 60-line string.

**Files:**
- Create: `apps/agent-orchestrator/src/skills/generationPrompt.ts`
- Test: `apps/agent-orchestrator/src/skills/__tests__/generationPrompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SkillBrief {
    name: string;
    description?: string;
    brief: string;
    previousDraft?: string;
    feedback?: string;
  }
  export const SKILL_SYSTEM_PROMPT: string;
  export function buildSkillPrompt(input: SkillBrief): string;
  ```
  Task 4 imports both `SKILL_SYSTEM_PROMPT` and `buildSkillPrompt`.

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/skills/__tests__/generationPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SKILL_SYSTEM_PROMPT, buildSkillPrompt } from '../generationPrompt.js'

describe('SKILL_SYSTEM_PROMPT', () => {
  // The manifest parser requires a --- YAML block with name and description.
  // If the prompt stops saying so, every generated skill fails on save, and
  // the failure surfaces two services away from the cause.
  it('states the frontmatter contract the manifest parser enforces', () => {
    expect(SKILL_SYSTEM_PROMPT).toContain('---')
    expect(SKILL_SYSTEM_PROMPT).toContain('name:')
    expect(SKILL_SYSTEM_PROMPT).toContain('description:')
  })

  it('tells the model to write for an agent, not a human reader', () => {
    expect(SKILL_SYSTEM_PROMPT.toLowerCase()).toContain('agent')
  })
})

describe('buildSkillPrompt', () => {
  it('carries the name and brief', () => {
    const prompt = buildSkillPrompt({ name: 'Bid Writer', brief: 'Help write RFP responses' })
    expect(prompt).toContain('Bid Writer')
    expect(prompt).toContain('Help write RFP responses')
  })

  it('omits the revision section when there is no previous draft', () => {
    const prompt = buildSkillPrompt({ name: 'Bid Writer', brief: 'Help write RFP responses' })
    expect(prompt).not.toContain('previous draft')
  })

  it('includes the previous draft and the feedback when revising', () => {
    const prompt = buildSkillPrompt({
      name: 'Bid Writer',
      brief: 'Help write RFP responses',
      previousDraft: '---\nname: bid-writer\ndescription: d\n---\n\nOld body.',
      feedback: 'Make it shorter',
    })
    expect(prompt).toContain('Old body.')
    expect(prompt).toContain('Make it shorter')
  })

  // A draft with no feedback is still a revision request — "try again" — and
  // must not silently look like a first generation.
  it('includes the previous draft even when feedback is absent', () => {
    const prompt = buildSkillPrompt({
      name: 'Bid Writer',
      brief: 'Help write RFP responses',
      previousDraft: '---\nname: bid-writer\ndescription: d\n---\n\nOld body.',
    })
    expect(prompt).toContain('Old body.')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm test -- generationPrompt`
Expected: FAIL — cannot resolve `../generationPrompt.js`.

- [ ] **Step 3: Write the prompt module**

Create `apps/agent-orchestrator/src/skills/generationPrompt.ts`:

```ts
// The prompt is the whole quality bar for created skills, and it is also the
// only thing standing between a user's brief and a version row that fails on
// SKILL.md frontmatter two services away. Both concerns live here so they can
// be tested without a model call.

export interface SkillBrief {
  name: string
  description?: string
  brief: string
  previousDraft?: string
  feedback?: string
}

export const SKILL_SYSTEM_PROMPT = `You write SKILL.md files. A skill is a page in a manual that an AI agent reads before doing a task — it is not documentation for a human, and not marketing copy.

Output rules, all mandatory:

1. Output the file and nothing else. No code fences, no preamble, no closing remarks.
2. Begin with a YAML frontmatter block, delimited by a line containing exactly --- before and after it. The block must contain:
   name: a lowercase kebab-case identifier, 2-4 words
   description: one sentence, under 200 characters, saying when an agent should use this skill
3. After the closing ---, write the body in Markdown.

Write the body as instructions addressed to the agent that will follow them:

- Lead with when the skill applies and when it does not.
- Give concrete steps, rules, and worked examples in the user's own domain vocabulary.
- Prefer specifics over generalities: exact phrasings, exact formats, exact thresholds. "Open with the client's name and the tender reference" beats "personalize the opening".
- State what to avoid, and why, where getting it wrong is likely.
- Keep it under roughly 400 lines. A skill an agent can hold in context beats an exhaustive one it skims.

Never invent facts about the user's business, customers, or numbers. Where a specific the agent needs is unknown, tell the agent to ask for it rather than filling it in.`

export function buildSkillPrompt(input: SkillBrief): string {
  const { name, description, brief, previousDraft, feedback } = input

  const sections = [
    `Skill name the user gave: ${name}`,
    description ? `One-line description the user gave: ${description}` : null,
    `What the user wants this skill to do:\n${brief}`,
  ].filter(Boolean)

  if (previousDraft) {
    sections.push(
      `Here is the previous draft you produced. Rewrite it in full — output the complete new file, not a diff or a description of changes.\n\n${previousDraft}`,
    )
    sections.push(
      feedback
        ? `What the user wants changed about that previous draft:\n${feedback}`
        : 'The user asked for another attempt without saying what was wrong. Produce a materially different draft rather than a reworded copy of the previous one.',
    )
  }

  return sections.join('\n\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm test -- generationPrompt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/skills/
git commit -m "feat(skills): prompt for generating a SKILL.md from a brief

The prompt carries the frontmatter contract the manifest parser enforces,
so a drafting mistake here becomes a failed version two services away.
Isolating it makes that contract testable without a model call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 4: Generation route in the orchestrator

**Files:**
- Create: `apps/agent-orchestrator/src/routes/skills.ts`
- Create: `apps/agent-orchestrator/src/routes/__tests__/skills.test.ts`
- Modify: `apps/agent-orchestrator/src/app.ts:32-41` (the `app.route('', ...)` block)

**Interfaces:**
- Consumes: `SKILL_SYSTEM_PROMPT`, `buildSkillPrompt`, `SkillBrief` from Task 3. Existing: `validateToken` (`../auth.js`), `checkCreditBalance` / `debitChatTurn` (`../credits.js`), `persistCost` (`../mastra/cost.js`), `recordUsage` (`../usage.js`), `platformModel` (`../mastra/model.js`), `getAllowedOrigin` (`../types.js`).
- Produces: `export const skillsRouter: Hono`, serving `POST /api/skills/generate` (SSE: `delta` events `{ text }`, then `done` `{ model }`; `error` `{ message }`) and `OPTIONS /api/skills/generate`. Task 5's dialog consumes this wire format.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent-orchestrator/src/routes/__tests__/skills.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const validateTokenMock = vi.hoisted(() => vi.fn())
vi.mock('../../auth.js', () => ({ validateToken: validateTokenMock }))

const checkCreditBalanceMock = vi.hoisted(() => vi.fn())
const debitChatTurnMock = vi.hoisted(() => vi.fn())
vi.mock('../../credits.js', () => ({
  checkCreditBalance: checkCreditBalanceMock,
  debitChatTurn: debitChatTurnMock,
}))

const persistCostMock = vi.hoisted(() => vi.fn())
vi.mock('../../mastra/cost.js', () => ({ persistCost: persistCostMock }))

const recordUsageMock = vi.hoisted(() => vi.fn())
vi.mock('../../usage.js', () => ({ recordUsage: recordUsageMock }))

vi.mock('../../mastra/model.js', () => ({ platformModel: { modelId: 'gemini-2.5-flash' } }))

const streamTextMock = vi.hoisted(() => vi.fn())
vi.mock('ai', () => ({ streamText: streamTextMock }))

function streamOf(chunks: string[], usage = { inputTokens: 900, outputTokens: 1_800 }) {
  return {
    textStream: (async function* () { for (const c of chunks) yield c })(),
    usage: Promise.resolve(usage),
  }
}

async function readSSE(res: Response): Promise<string> {
  return await res.text()
}

const VALID_CLAIMS = { sub: 'user-1', 'custom:tenantId': 'tenant-1' }
const BODY = { name: 'Bid Writer', brief: 'Help write RFP responses' }

async function request(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer token' }) {
  const { skillsRouter } = await import('../skills.js')
  const { Hono } = await import('hono')
  const app = new Hono()
  app.route('', skillsRouter)
  return app.request('/api/skills/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/skills/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateTokenMock.mockResolvedValue(VALID_CLAIMS)
    checkCreditBalanceMock.mockResolvedValue({ allowed: true, balanceMicro: 100n, unlimited: false })
    streamTextMock.mockReturnValue(streamOf(['---\nname: bid-writer\n', 'description: d\n---\n\nBody.']))
  })

  it('rejects a request with no bearer token', async () => {
    const res = await request(BODY, {})
    expect(res.status).toBe(401)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('rejects a request whose token fails validation', async () => {
    validateTokenMock.mockRejectedValue(new Error('bad token'))
    const res = await request(BODY)
    expect(res.status).toBe(401)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('rejects a body with no brief', async () => {
    const res = await request({ name: 'Bid Writer' })
    expect(res.status).toBe(400)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('returns 402 before streaming when the tenant is out of credits', async () => {
    checkCreditBalanceMock.mockResolvedValue({ allowed: false, balanceMicro: 0n, unlimited: false })
    const res = await request(BODY)
    expect(res.status).toBe(402)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('streams the generated text as delta events and ends with done', async () => {
    const res = await request(BODY)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const text = await readSSE(res)
    expect(text).toContain('event: delta')
    expect(text).toContain('bid-writer')
    expect(text.trimEnd().endsWith('}')).toBe(true)
    expect(text).toContain('event: done')
  })

  // The tenant a caller can spend against must come from the signed token, not
  // from anything the caller can type.
  it('debits the tenant from the token claim, ignoring a tenantId in the body', async () => {
    const res = await request({ ...BODY, tenantId: 'tenant-999' })
    await readSSE(res)
    expect(debitChatTurnMock).toHaveBeenCalledTimes(1)
    expect(debitChatTurnMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      agentId: 'skill-generator',
      model: 'gemini-2.5-flash',
      inputTokens: 900,
      outputTokens: 1_800,
    })
    expect(debitChatTurnMock.mock.calls[0][0].messageId).toMatch(/^skillgen:/)
  })

  it('records usage and cost alongside the debit', async () => {
    const res = await request(BODY)
    await readSSE(res)
    expect(persistCostMock).toHaveBeenCalledTimes(1)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
  })

  it('emits an error event and no debit when the model stream throws', async () => {
    streamTextMock.mockReturnValue({
      textStream: (async function* () { throw new Error('gateway down') })(),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    })
    const res = await request(BODY)
    const text = await readSSE(res)
    expect(text).toContain('event: error')
    expect(text).not.toContain('gateway down')  // internal detail stays server-side
    expect(debitChatTurnMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm test -- routes/__tests__/skills`
Expected: FAIL — cannot resolve `../skills.js`.

- [ ] **Step 3: Write the route**

Create `apps/agent-orchestrator/src/routes/skills.ts`:

```ts
import { Hono } from 'hono'
import { streamText } from 'ai'
import type { AuthPayload } from '../auth.js'
import { validateToken } from '../auth.js'
import { checkCreditBalance, debitChatTurn } from '../credits.js'
import { persistCost } from '../mastra/cost.js'
import { recordUsage } from '../usage.js'
import { platformModel } from '../mastra/model.js'
import { getAllowedOrigin } from '../types.js'
import { SKILL_SYSTEM_PROMPT, buildSkillPrompt } from '../skills/generationPrompt.js'

export const skillsRouter = new Hono()

const MAX_BRIEF = 4_000
const MAX_DRAFT = 65_536
const GENERATOR_AGENT_ID = 'skill-generator'

skillsRouter.options('/api/skills/generate', (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})

skillsRouter.post('/api/skills/generate', async (c) => {
  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: AuthPayload
  try {
    payload = await validateToken(token)
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Never from the body: the body is caller-controlled and this value decides
  // whose credits get spent.
  const tenantId = payload['custom:tenantId'] ?? ''
  if (!tenantId) return c.json({ error: 'Unauthorized' }, 401)

  const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  const brief = typeof raw?.brief === 'string' ? raw.brief.trim() : ''
  const description = typeof raw?.description === 'string' ? raw.description.trim() : undefined
  const previousDraft = typeof raw?.previousDraft === 'string' ? raw.previousDraft.slice(0, MAX_DRAFT) : undefined
  const feedback = typeof raw?.feedback === 'string' ? raw.feedback.trim() : undefined
  if (!name || !brief || brief.length > MAX_BRIEF) {
    return c.json({ error: 'name and brief are required', code: 'VALIDATION_ERROR' }, 400)
  }

  // Checked before the stream opens so an out-of-credit tenant gets a plain
  // 402 the dialog can render, not an error buried inside an SSE body.
  const credit = await checkCreditBalance(tenantId)
  if (!credit.allowed) {
    return c.json({ error: 'Insufficient credits', balanceMicro: String(credit.balanceMicro) }, 402)
  }

  const modelName = (platformModel as { modelId?: string }).modelId ?? 'gemini-2.5-flash'
  const generationId = crypto.randomUUID()
  const encoder = new TextEncoder()

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: object): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // enqueue after close — client went away
        }
      }

      try {
        const result = streamText({
          model: platformModel,
          system: SKILL_SYSTEM_PROMPT,
          prompt: buildSkillPrompt({ name, description, brief, previousDraft, feedback }),
        })

        for await (const chunk of result.textStream) {
          send('delta', { text: chunk })
        }

        const usage = await result.usage
        const inputTokens = usage?.inputTokens ?? 0
        const outputTokens = usage?.outputTokens ?? 0

        // Same post-turn trio as chatStream.ts: the cost row, the usage row,
        // and the debit. All three are fire-and-forget by contract — a metering
        // failure must never take down a draft the user already has.
        persistCost({ tenantId, agentId: GENERATOR_AGENT_ID, model: modelName, inputTokens, outputTokens })
        recordUsage({ tenantId, actorId: GENERATOR_AGENT_ID, inputTokens, outputTokens })
        debitChatTurn({
          tenantId,
          agentId: GENERATOR_AGENT_ID,
          messageId: `skillgen:${generationId}`,
          model: modelName,
          inputTokens,
          outputTokens,
        })

        send('done', { model: modelName })
      } catch (err) {
        // The gateway's own message can name internal hosts and model routing,
        // so it stays in the server log; the client gets something it can act on.
        console.error(`[skillgen:${generationId}] generation failed tenantId=${tenantId}:`, (err as Error).message)
        send('error', { message: 'Generation failed. Try again.' })
      } finally {
        try { controller.close() } catch {}
      }
    },
  })

  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})
```

Check `persistCost`'s `CostRecord` type and `recordUsage`'s signature in `apps/agent-orchestrator/src/mastra/cost.ts` and `src/usage.ts` before finishing — if either requires fields not passed above (e.g. `workflowId`, `runId`), pass `undefined`/`null` explicitly rather than omitting them.

- [ ] **Step 4: Mount the router**

In `apps/agent-orchestrator/src/app.ts`, add the import beside the others and mount it in the same block (after `app.route('', explanationRouter)`):

```ts
app.route('', skillsRouter)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm test -- routes/__tests__/skills`
Expected: PASS, all nine tests.

- [ ] **Step 6: Run the full orchestrator suite and type-check**

Run: `cd apps/agent-orchestrator && pnpm test && pnpm exec tsc --noEmit`
Expected: no new failures. If the suite has pre-existing failures on this branch, note which ones and confirm they also fail on `main` before moving on.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/routes/skills.ts \
        apps/agent-orchestrator/src/routes/__tests__/skills.test.ts \
        apps/agent-orchestrator/src/app.ts
git commit -m "feat(skills): stream a generated SKILL.md from the orchestrator

Generation runs here rather than in the API Lambda because this is where
the inference gateway and the credit helpers already are. The tenant comes
from the signed token, never the body, and the credit check happens before
the stream opens so an empty balance is a plain 402 instead of an error
buried in an SSE body.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 5: Web client — generate stream + authored save

The data layer for the dialog, separated from it so the streaming and the save can be tested without rendering.

**Files:**
- Modify: `apps/web/components/platform/skills/actions.ts` (add `createSkillFromBody`; add parked-code comments to the three `createSkillFrom*` import helpers)
- Create: `apps/web/components/platform/skills/generateSkill.ts`
- Test: `apps/web/components/platform/skills/actions.test.ts` (extend), `apps/web/components/platform/skills/generateSkill.test.ts` (create)

**Interfaces:**
- Consumes: the SSE wire format from Task 4; the `authored` source from Task 1.
- Produces:
  ```ts
  // actions.ts
  export async function createSkillFromBody(name: string, description: string, body: string): Promise<void>
  // generateSkill.ts
  export interface GenerateSkillInput { name: string; description?: string; brief: string; previousDraft?: string; feedback?: string }
  export interface GenerateSkillHandlers { onDelta: (text: string) => void; signal?: AbortSignal }
  export class SkillGenerationError extends Error { constructor(message: string, public code: 'UNAUTHORIZED' | 'NO_CREDITS' | 'FAILED') }
  export async function generateSkill(input: GenerateSkillInput, handlers: GenerateSkillHandlers): Promise<string>
  ```
  Task 6's dialog consumes both.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/platform/skills/generateSkill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSkill, SkillGenerationError } from './generateSkill';

function sseResponse(frames: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
        },
    });
    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const INPUT = { name: 'Bid Writer', brief: 'Help write RFP responses' };

describe('generateSkill', () => {
    beforeEach(() => {
        document.cookie = 'platform_id_token=test-token';
    });
    afterEach(() => vi.restoreAllMocks());

    it('accumulates delta events into the full draft', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"text":"---\\nname: bid-writer\\n"}\n\n',
            'event: delta\ndata: {"text":"description: d\\n---\\n\\nBody."}\n\n',
            'event: done\ndata: {"model":"gemini-2.5-flash"}\n\n',
        ])));

        const seen: string[] = [];
        const draft = await generateSkill(INPUT, { onDelta: (t) => seen.push(t) });

        expect(seen).toHaveLength(2);
        expect(draft).toBe('---\nname: bid-writer\ndescription: d\n---\n\nBody.');
    });

    // A delta split across two network chunks must not be parsed as two events
    // or dropped — the buffer only yields on a complete \n\n frame.
    it('handles an event split across chunk boundaries', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"te',
            'xt":"hello"}\n\nevent: done\ndata: {}\n\n',
        ])));

        const draft = await generateSkill(INPUT, { onDelta: () => {} });
        expect(draft).toBe('hello');
    });

    it('throws NO_CREDITS on a 402', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 402 })));
        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toMatchObject({ code: 'NO_CREDITS' });
    });

    it('throws UNAUTHORIZED on a 401', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('throws FAILED when the stream sends an error event', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"text":"partial"}\n\n',
            'event: error\ndata: {"message":"Generation failed. Try again."}\n\n',
        ])));

        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toBeInstanceOf(SkillGenerationError);
    });

    it('sends the previous draft and feedback when revising', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(['event: done\ndata: {}\n\n']));
        vi.stubGlobal('fetch', fetchMock);

        await generateSkill({ ...INPUT, previousDraft: 'old', feedback: 'shorter' }, { onDelta: () => {} });

        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({ previousDraft: 'old', feedback: 'shorter' });
        expect(init.headers.Authorization).toBe('Bearer test-token');
    });
});
```

Append to `apps/web/components/platform/skills/actions.test.ts` (match the file's existing mock of `@/lib/api`):

```ts
describe('createSkillFromBody', () => {
    it('posts an authored source with the generated body', async () => {
        const { createSkillFromBody } = await import('./actions');
        await createSkillFromBody('Bid Writer', 'Writes bids', '---\nname: bid-writer\ndescription: d\n---\n\nBody.');

        expect(apiMock.post).toHaveBeenCalledWith('/api/v1/skills', {
            name: 'Bid Writer',
            description: 'Writes bids',
            source: { type: 'authored', body: '---\nname: bid-writer\ndescription: d\n---\n\nBody.' },
        });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm test -- skills`
Expected: FAIL — `./generateSkill` does not exist; `createSkillFromBody` is not exported.

- [ ] **Step 3: Write `generateSkill.ts`**

Create `apps/web/components/platform/skills/generateSkill.ts`:

```ts
// Talks to the agent-orchestrator directly, the same way chat and schedules do
// — not through /api/proxy, which is the API Lambda's path. Auth is the
// non-httpOnly platform_id_token cookie carried as a Bearer token, matching
// scheduled/orchestratorClient.ts.

const ORCHESTRATOR_BASE =
    process.env.NEXT_PUBLIC_AGENT_WS_URL?.replace(/^wss?:\/\//, 'https://')
    ?? 'https://agent-orchestrator.projectcontext.co';

export interface GenerateSkillInput {
    name: string;
    description?: string;
    brief: string;
    previousDraft?: string;
    feedback?: string;
}

export interface GenerateSkillHandlers {
    onDelta: (text: string) => void;
    signal?: AbortSignal;
}

export class SkillGenerationError extends Error {
    constructor(message: string, public code: 'UNAUTHORIZED' | 'NO_CREDITS' | 'FAILED') {
        super(message);
        this.name = 'SkillGenerationError';
    }
}

function getIdToken(): string {
    if (typeof document === 'undefined') return '';
    return document.cookie.split('; ').find((r) => r.startsWith('platform_id_token='))?.split('=')[1] ?? '';
}

/**
 * Streams a generated SKILL.md, calling onDelta with each chunk, and resolves
 * with the full draft. Rejects with a SkillGenerationError carrying a code the
 * dialog can turn into copy.
 */
export async function generateSkill(
    input: GenerateSkillInput,
    { onDelta, signal }: GenerateSkillHandlers,
): Promise<string> {
    const res = await fetch(`${ORCHESTRATOR_BASE}/api/skills/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getIdToken()}` },
        body: JSON.stringify(input),
        signal,
    });

    if (res.status === 401) throw new SkillGenerationError('Session expired — sign in again.', 'UNAUTHORIZED');
    if (res.status === 402) throw new SkillGenerationError('Not enough credits to generate a skill.', 'NO_CREDITS');
    if (!res.ok || !res.body) throw new SkillGenerationError('Generation failed. Try again.', 'FAILED');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let draft = '';
    let streamError: SkillGenerationError | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; anything after the last \n\n is
        // a partial frame and stays in the buffer until the rest arrives.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');

            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice(7).trim();
            let data: Record<string, unknown>;
            try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

            if (event === 'delta' && typeof data.text === 'string') {
                draft += data.text;
                onDelta(data.text);
            } else if (event === 'error') {
                streamError = new SkillGenerationError(
                    typeof data.message === 'string' ? data.message : 'Generation failed. Try again.',
                    'FAILED',
                );
            }
        }
    }

    if (streamError) throw streamError;
    return draft;
}
```

- [ ] **Step 4: Add `createSkillFromBody` and the parked-code comments**

In `apps/web/components/platform/skills/actions.ts`, add after `createSkillFromUrl`:

```ts
/**
 * Creates a skill from a SKILL.md body written in the app (see
 * CreateSkillDialog). The server treats it as an 'authored' source and runs it
 * through the same import worker a zip goes through, so it lands `pending` and
 * flips to `ready` a moment later — the page already polls for that.
 */
export async function createSkillFromBody(name: string, description: string, body: string): Promise<void> {
    await api.post("/api/v1/skills", { name, description, source: { type: "authored", body } });
}
```

Add a comment above `getUploadUrl` (the first of the import helpers):

```ts
// ─── Package import — parked ──────────────────────────────────────────────
// getUploadUrl through createSkillFromUrl, and ImportSkillDialog alongside
// them, have no caller: importing a pre-built package is a developer action
// and belongs in the dev studio, not on the tenant Skills page. The backend
// routes and the import worker are all live and tested — this is UI that's
// waiting for a home, not dead code to delete.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && pnpm test -- skills`
Expected: PASS, including the existing `actions.test.ts` cases.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/skills/generateSkill.ts \
        apps/web/components/platform/skills/generateSkill.test.ts \
        apps/web/components/platform/skills/actions.ts \
        apps/web/components/platform/skills/actions.test.ts
git commit -m "feat(skills): client for streaming generation and authored save

generateSkill talks to the orchestrator directly, as chat and schedules do,
and buffers on frame boundaries so a delta split across network chunks is
neither dropped nor parsed twice. The import helpers stay put with a note
saying they are waiting on the dev studio rather than rotting.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 6: `CreateSkillDialog` and the page swap

The user-visible change. After this task the feature is complete end to end.

**Files:**
- Create: `apps/web/components/platform/skills/CreateSkillDialog.tsx`
- Create: `apps/web/components/platform/skills/CreateSkillDialog.test.tsx`
- Modify: `apps/web/app/[tenant]/dashboard/skills/page.tsx` (lines ~11 import, ~41 state, ~118 button, ~140 empty message, ~164-168 dialog)
- Modify: `apps/web/components/platform/skills/ImportSkillDialog.tsx` (header comment only)

**Interfaces:**
- Consumes: `generateSkill`, `SkillGenerationError`, `createSkillFromBody` from Task 5.
- Produces: `export function CreateSkillDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/platform/skills/CreateSkillDialog.test.tsx`. Match the setup style of the existing `SkillCard.test.tsx` / `SkillDetailContent.test.tsx` (they establish how this repo renders shadcn components under Vitest — read one before writing this):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateSkillDialog } from './CreateSkillDialog';

const generateSkillMock = vi.hoisted(() => vi.fn());
const createSkillFromBodyMock = vi.hoisted(() => vi.fn());
vi.mock('./generateSkill', async () => {
    const actual = await vi.importActual<typeof import('./generateSkill')>('./generateSkill');
    return { ...actual, generateSkill: generateSkillMock };
});
vi.mock('./actions', () => ({ createSkillFromBody: createSkillFromBodyMock }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DRAFT = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nAlways open with the client name.';

function renderDialog(onCreated = vi.fn()) {
    return render(<CreateSkillDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
}

describe('CreateSkillDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        generateSkillMock.mockImplementation(async (_input, { onDelta }) => { onDelta(DRAFT); return DRAFT; });
    });

    it('will not generate without a name and a brief', async () => {
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: /generate/i }));
        expect(generateSkillMock).not.toHaveBeenCalled();
    });

    it('generates from the brief and shows the draft', async () => {
        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), 'Bid Writer');
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), 'Help write RFP responses');
        await userEvent.click(screen.getByRole('button', { name: /generate/i }));

        await waitFor(() => expect(screen.getByText(/always open with the client name/i)).toBeInTheDocument());
        expect(generateSkillMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Bid Writer', brief: 'Help write RFP responses' }),
            expect.anything(),
        );
    });

    it('saves the generated draft and reports back', async () => {
        const onCreated = vi.fn();
        renderDialog(onCreated);
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), 'Bid Writer');
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), 'Help write RFP responses');
        await userEvent.click(screen.getByRole('button', { name: /generate/i }));
        await waitFor(() => screen.getByRole('button', { name: /save skill/i }));
        await userEvent.click(screen.getByRole('button', { name: /save skill/i }));

        await waitFor(() => expect(createSkillFromBodyMock).toHaveBeenCalledWith('Bid Writer', '', DRAFT));
        expect(onCreated).toHaveBeenCalled();
    });

    it('sends the previous draft when regenerating with feedback', async () => {
        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), 'Bid Writer');
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), 'Help write RFP responses');
        await userEvent.click(screen.getByRole('button', { name: /generate/i }));
        await waitFor(() => screen.getByRole('button', { name: /regenerate/i }));
        await userEvent.click(screen.getByRole('button', { name: /regenerate/i }));
        await userEvent.type(screen.getByPlaceholderText(/what should change/i), 'Make it shorter');
        await userEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));

        await waitFor(() => expect(generateSkillMock).toHaveBeenCalledTimes(2));
        expect(generateSkillMock.mock.calls[1][0]).toMatchObject({ previousDraft: DRAFT, feedback: 'Make it shorter' });
    });

    // A failed generation must leave the user where they were, with their brief
    // intact — not on an empty preview with nothing to retry from.
    it('shows the error and keeps the draft retryable when generation fails', async () => {
        const { SkillGenerationError } = await import('./generateSkill');
        generateSkillMock.mockRejectedValue(new SkillGenerationError('Not enough credits to generate a skill.', 'NO_CREDITS'));

        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), 'Bid Writer');
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), 'Help write RFP responses');
        await userEvent.click(screen.getByRole('button', { name: /generate/i }));

        await waitFor(() => expect(screen.getByText(/not enough credits/i)).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /generate/i })).toBeEnabled();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm test -- CreateSkillDialog`
Expected: FAIL — `./CreateSkillDialog` does not exist.

- [ ] **Step 3: Write the dialog**

Create `apps/web/components/platform/skills/CreateSkillDialog.tsx`. Reuse `ImportSkillDialog.tsx`'s imports and structure (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Input`, `Textarea`, `Button`, `cn`) so the two look like siblings:

```tsx
"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { generateSkill, SkillGenerationError } from "./generateSkill";
import { createSkillFromBody } from "./actions";

interface CreateSkillDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}

const BRIEF_PLACEHOLDER =
    "What should this skill teach the agent? e.g. How to write our RFP responses — always open with the client name and tender reference, lead with delivery track record, and never quote a price without a caveat.";

export function CreateSkillDialog({ open, onOpenChange, onCreated }: CreateSkillDialogProps) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [brief, setBrief] = useState("");
    const [draft, setDraft] = useState("");
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showFeedback, setShowFeedback] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [generateCount, setGenerateCount] = useState(0);
    // The draft is appended to from a stream callback that fires many times per
    // second; a ref accumulates it so each delta isn't a full React render of a
    // growing string.
    const draftRef = useRef("");

    const reset = () => {
        setName(""); setDescription(""); setBrief(""); setDraft("");
        setError(null); setShowFeedback(false); setFeedback(""); setGenerateCount(0);
        draftRef.current = "";
    };

    const runGeneration = async (revision: boolean) => {
        if (!name.trim() || !brief.trim()) { setError("Name and brief are required"); return; }
        const previousDraft = revision ? draftRef.current : undefined;
        setGenerating(true);
        setError(null);
        draftRef.current = "";
        setDraft("");
        try {
            const full = await generateSkill(
                {
                    name: name.trim(),
                    description: description.trim() || undefined,
                    brief: brief.trim(),
                    previousDraft,
                    feedback: revision && feedback.trim() ? feedback.trim() : undefined,
                },
                {
                    onDelta: (text) => {
                        draftRef.current += text;
                        setDraft(draftRef.current);
                    },
                },
            );
            draftRef.current = full;
            setDraft(full);
            setGenerateCount((n) => n + 1);
            setShowFeedback(false);
            setFeedback("");
        } catch (err) {
            setError(err instanceof SkillGenerationError ? err.message : "Generation failed. Try again.");
        } finally {
            setGenerating(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            await createSkillFromBody(name.trim(), description.trim(), draftRef.current);
            toast.success("Skill created — it'll be ready in a moment.");
            reset();
            onOpenChange(false);
            onCreated();
        } catch {
            setError("Couldn't save the skill. Try again.");
        } finally {
            setSaving(false);
        }
    };

    const hasDraft = draft.length > 0;

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Create a skill</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <Input placeholder="Skill name" value={name} onChange={(e) => setName(e.target.value)} disabled={generating} />
                    <Input placeholder="One-line description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} disabled={generating} />
                    <Textarea
                        placeholder={BRIEF_PLACEHOLDER}
                        value={brief}
                        onChange={(e) => setBrief(e.target.value)}
                        disabled={generating}
                        className="min-h-[120px]"
                    />

                    {hasDraft && (
                        <pre className="max-h-[320px] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono">
                            {draft}
                        </pre>
                    )}

                    {showFeedback && (
                        <Input
                            placeholder="What should change?"
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            disabled={generating}
                        />
                    )}

                    {error && <p className="text-xs text-destructive">{error}</p>}

                    {/* Only mention the charge once the user has generated more than
                        once — on the common path it's a fraction of a credit and the
                        warning would cost more attention than the spend. */}
                    {generateCount > 1 && (
                        <p className="text-xs text-muted-foreground">Each attempt uses a small number of credits.</p>
                    )}

                    <div className="flex gap-2">
                        {!hasDraft ? (
                            <Button onClick={() => runGeneration(false)} disabled={generating} className="w-full">
                                {generating ? "Generating…" : "Generate"}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant="outline"
                                    disabled={generating || saving}
                                    onClick={() => (showFeedback ? runGeneration(true) : setShowFeedback(true))}
                                >
                                    Regenerate
                                </Button>
                                <Button onClick={handleSave} disabled={generating || saving} className="flex-1">
                                    {saving ? "Saving…" : "Save skill"}
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm test -- CreateSkillDialog`
Expected: PASS. If a query fails because a shadcn `Dialog` renders in a portal, follow whatever pattern the existing `SkillDetailContent.test.tsx` uses rather than changing the component to suit the test.

- [ ] **Step 5: Swap the page over**

In `apps/web/app/[tenant]/dashboard/skills/page.tsx`:

Replace the import line

```tsx
import { ImportSkillDialog } from "@/components/platform/skills/ImportSkillDialog";
```

with

```tsx
import { CreateSkillDialog } from "@/components/platform/skills/CreateSkillDialog";
```

Rename the state:

```tsx
    const [createOpen, setCreateOpen] = useState(false);
```

Header:

```tsx
                    <p className="text-muted-foreground mt-2">Create, install, and share reusable skill packages</p>
                </div>
                <Button onClick={() => setCreateOpen(true)}>+ Create skill</Button>
```

`mine` grid empty message:

```tsx
                    emptyMessage="No skills yet — create one to get started."
```

And the dialog itself:

```tsx
            <CreateSkillDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onCreated={() => queryClient.invalidateQueries({ queryKey: ["skills"] })}
            />
```

- [ ] **Step 6: Add the parked comment to `ImportSkillDialog.tsx`**

At the very top of `apps/web/components/platform/skills/ImportSkillDialog.tsx`, above `"use client";`:

```tsx
// Parked, deliberately: nothing renders this. Importing a pre-built skill
// package is a developer action and belongs in the dev studio, which doesn't
// exist yet — the tenant Skills page offers Create instead. The backend it
// calls (POST /skills/upload-url, the zip/github/url sources, the skill.import
// worker) is all live and tested. Delete this only if that decision is reversed.
```

- [ ] **Step 7: Run the full web suite, lint, and type-check**

Run: `cd apps/web && pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS. An unused-export warning on the `createSkillFrom*` helpers is acceptable and expected; an unused-*import* error is not — if lint flags one, the page still references something it shouldn't.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/platform/skills/CreateSkillDialog.tsx \
        apps/web/components/platform/skills/CreateSkillDialog.test.tsx \
        apps/web/components/platform/skills/ImportSkillDialog.tsx \
        "apps/web/app/[tenant]/dashboard/skills/page.tsx"
git commit -m "feat(skills): create a skill from a brief instead of importing one

Import asked for a zip, a repo, or a URL — every one of which assumes the
user already authored SKILL.md by hand. Now they describe what the skill
should teach the agent and review the draft. The import dialog stays on
disk, rendered by nothing, waiting on the dev studio.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 7: Verify end to end, then hand off for deploy

No new code. This task exists because the three surfaces deploy separately and a green test suite proves none of that.

- [ ] **Step 1: Run every touched package's suite**

```bash
pnpm --filter @serverless-saas/agent-api test
pnpm --filter @serverless-saas/agent-worker-handlers test
pnpm --filter agent-orchestrator test
pnpm --filter @serverless-saas/web test
```

Expected: all PASS. Record any failure that also reproduces on `main` — that one is pre-existing, not yours.

- [ ] **Step 2: Build everything the Lambda bundle depends on**

```bash
pnpm build
```

Expected: success. A stale `dist/` in a product package makes `sam deploy` silently ship old compiled JS, which is the exact failure mode this repo has hit before.

- [ ] **Step 3: Confirm the migration is the only schema change**

```bash
git diff main --stat -- packages/foundation/database/migrations/
```

Expected: exactly one new `.sql` file plus the `_journal.json` line. If `drizzle-kit generate` was run at any point, a regenerated snapshot may have crept in — revert anything unrelated to `skill_source_type`.

- [ ] **Step 4: Write the deploy handoff**

Report to the user, in this order (it matters — the enum value must exist before the Lambda that writes it):

1. Apply the migration: `cd packages/foundation/database && pnpm exec drizzle-kit migrate` against the dev `DATABASE_URL`.
2. `sam deploy --config-file samconfig.dev.toml` — ships the API Lambda and TaskWorker.
3. `pm2 restart agent-orchestrator` on the GCP VM, by hand. `./deploy.sh` does not touch it, and without this the generate endpoint 404s.
4. `./deploy.sh` — rebuilds and restarts the web frontend.

Note that SSH to the VM has failed from this sandbox before, so step 3 is likely the user's to run.

- [ ] **Step 5: Manual smoke test (user-run, after deploy)**

Give the user this list:
- Skills page shows **+ Create skill**, no Import button.
- Create a skill from a real brief; the draft streams in rather than appearing all at once.
- Regenerate with feedback produces a materially different draft.
- Save; the card appears, sits `pending` briefly, then reads `v1`.
- Open the card — the detail modal renders the generated body.
- Attach it to an agent and send a message; the agent's behaviour reflects the skill.
- Check `credit_ledger` for two `chat:skillgen:*` debit rows (one per generation).

---

## Self-Review

**Spec coverage:** page swap → Task 6. `CreateSkillDialog` → Task 6. Generation route → Task 4 (prompt split into Task 3). Credits → Task 4. Authored source + migration → Task 1. Worker branch → Task 2. Error-handling table → Tasks 4 (401/402/stream error/oversized body), 5 (client codes), 6 (inline display). Testing section → Tasks 1-6. Deployment → Task 7. No gaps.

**Placeholders:** none — every code step carries real content. The two deliberate blanks are the migration's `00XX` number and its `when` epoch, both resolved by a command in the same step.

**Type consistency:** `SkillBrief` (Task 3) matches the route's parsed fields (Task 4) and `GenerateSkillInput` (Task 5). `createSkillFromBody(name, description, body)` is defined in Task 5 and called with three positional args in Task 6. `SkillGenerationError`'s codes (`UNAUTHORIZED` | `NO_CREDITS` | `FAILED`) are produced in Task 5 and consumed in Task 6. `{ type: 'authored', body }` is identical in Tasks 1, 2, 5.
