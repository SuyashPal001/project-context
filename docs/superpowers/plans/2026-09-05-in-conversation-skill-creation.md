# In-Conversation Skill Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent write a skill during a conversation — the user asks, the agent drafts SKILL.md, a confirmation card gates the write, and the skill is created, installed, and attached so it applies from the user's next message.

**Architecture:** A `create_skill` tool in the orchestrator validates the agent-written body, runs the PII filter, and gates on the existing generation-confirm card (extended with a non-priced `alwaysAsk` mode). On approval it POSTs to a new `/api/v1/internal/skills` route authorized by the internal service key, which enforces the acting user's real permissions, a daily quota, and an idempotency claim before creating the skill as an `authored` source. The import worker attaches it once the version reaches `ready`. Underneath all of that, `fetchAgentSkill`'s `LIMIT 1` is replaced by real composition — without which attaching a second skill silently switches the first one off.

**Tech Stack:** Hono (API Lambda + orchestrator), Mastra `createTool`, Drizzle + Postgres, `@serverless-saas/cache` Redis via `IdempotencyStore`, `@serverless-saas/permissions`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-in-conversation-skill-creation-design.md`

## Global Constraints

- `apps/agent-orchestrator` is ESM: every relative import carries an explicit `.js` suffix even though files on disk are `.ts`. API and worker packages do not.
- Package scope is `@serverless-saas/*`. Agent-platform tables come from `@serverless-saas/agent-schema/*`.
- Composition caps, exact: **8** attached skills per agent (`MAX_ATTACHED_SKILLS`), **24,000** characters of composed skill text (`MAX_COMPOSED_SKILL_CHARS`).
- Daily quota, exact: **20** chat-created skills per tenant per day.
- SKILL.md body cap: **65,536** bytes, matching the public route's `z.string().min(1).max(65_536)`.
- The acting user's permissions are enforced server-side with `resolveUserPermissions`; the service key authenticates the *service*, never the person.
- `tenantId` never comes from a request body on a user-facing route. On the internal route it does, because the service key is the trust boundary — but the *user's* permissions are still checked against it.
- Test runner: `vitest run`. `pnpm test -- <file>` does NOT filter in this repo (the script is a bare `vitest run`, so `--` swallows the argument). Use `pnpm exec vitest run <path-or-pattern>`.
- `apps/agent-orchestrator` has ONE pre-existing failing suite, `src/__tests__/tasks-execute.test.ts` (ENOENT on `skills/roadmap-planning/SKILL.md`). It is unrelated to this work. Do not fix it; confirm it fails at the base commit and move on.
- Conventional Commits. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw
  ```
- `.gitignore` carries a blanket `*.md`; committing any Markdown needs `git add -f`.
- Commit only the files each task names. `git status` in this repo routinely shows unrelated work — never `git add -A` or `git commit -a`.

---

### Task 1: Compose every attached skill into the prompt

The defect this feature sits on. `fetchAgentSkill` returns one row, so a second attached skill has never applied. Fixing it first means every later task builds on real composition.

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts:38-72` (`AgentSkill`, `fetchAgentSkill`, `recordSkillRun`)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:12` (import), `:251-268` (call site)
- Modify: `apps/agent-orchestrator/src/mastra/agent.ts:63-66` (background-task call site)
- Test: `apps/agent-orchestrator/src/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const MAX_ATTACHED_SKILLS = 8
  export const MAX_COMPOSED_SKILL_CHARS = 24_000
  export interface ComposedAgentSkills {
    systemPrompt: string | null   // all bodies joined, or null when none
    installIds: string[]          // every composed install, for run counting
    droppedNames: string[]        // skills excluded by a cap
  }
  export async function fetchAgentSkills(agentId: string): Promise<ComposedAgentSkills>
  export async function recordSkillRuns(installIds: string[], tenantId: string): Promise<void>
  ```
  Task 2 reuses the two cap constants by re-declaring them in the API package (the orchestrator is not importable from the Lambda); keep the numbers identical.

- [ ] **Step 1: Write the failing tests**

Read `apps/agent-orchestrator/src/usage.test.ts` first — it already has a `getPool` mock and a `describe('recordSkillRun')` block whose style these follow. Add:

```ts
describe('fetchAgentSkills', () => {
  it('composes every active skill in attachment order', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', system_prompt: 'Open with the client name.', tools: null, config: null, install_id: 'install-1' },
      { name: 'tone-guide', system_prompt: 'Never promise a date.', tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1')

    // Both bodies present, first-attached first.
    expect(composed.systemPrompt).toContain('Open with the client name.')
    expect(composed.systemPrompt).toContain('Never promise a date.')
    expect(composed.systemPrompt!.indexOf('Open with')).toBeLessThan(composed.systemPrompt!.indexOf('Never promise'))
    expect(composed.installIds).toEqual(['install-1', 'install-2'])
    expect(composed.droppedNames).toEqual([])
  })

  it('orders by created_at ascending so the prompt is stable between turns', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await fetchAgentSkills('agent-1')
    const sql = queryMock.mock.calls[0][0] as string
    expect(sql).toContain('ORDER BY created_at ASC')
    expect(sql).not.toContain('LIMIT 1')
  })

  it('returns a null prompt when the agent has no active skills', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const composed = await fetchAgentSkills('agent-1')
    expect(composed).toEqual({ systemPrompt: null, installIds: [], droppedNames: [] })
  })

  // Legacy agents can already hold more rows than the cap allows — those rows
  // were being ignored entirely before this change, so dropping the overflow
  // is strictly better than today, but it must be loud rather than silent.
  it('drops skills past the count cap and names them', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${i}`, system_prompt: `body ${i}`, tools: null, config: null, install_id: `install-${i}`,
    }))
    queryMock.mockResolvedValueOnce({ rows })

    const composed = await fetchAgentSkills('agent-1')

    expect(composed.installIds).toHaveLength(8)
    expect(composed.droppedNames).toEqual(['skill-8', 'skill-9'])
    expect(composed.systemPrompt).not.toContain('body 8')
  })

  it('drops skills past the character budget', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { name: 'huge', system_prompt: 'x'.repeat(23_900), tools: null, config: null, install_id: 'install-1' },
      { name: 'small', system_prompt: 'y'.repeat(500), tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1')

    expect(composed.installIds).toEqual(['install-1'])
    expect(composed.droppedNames).toEqual(['small'])
    expect(composed.systemPrompt!.length).toBeLessThanOrEqual(24_000 + 200) // bodies plus per-skill headers
  })

  it('skips rows with a null system_prompt without dropping the rest', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { name: 'empty', system_prompt: null, tools: null, config: null, install_id: 'install-1' },
      { name: 'real', system_prompt: 'Do the thing.', tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1')

    expect(composed.systemPrompt).toContain('Do the thing.')
    expect(composed.installIds).toEqual(['install-2'])
  })
})

describe('recordSkillRuns', () => {
  it('increments every composed install, not just the first', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    await recordSkillRuns(['install-1', 'install-2'], 'tenant-1')
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls[0][1]).toEqual(['install-1', 'tenant-1'])
    expect(queryMock.mock.calls[1][1]).toEqual(['install-2', 'tenant-1'])
  })

  it('does nothing when there are no installs', async () => {
    await recordSkillRuns([], 'tenant-1')
    expect(queryMock).not.toHaveBeenCalled()
  })
})
```

If the existing file names its pool-query mock something other than `queryMock`, use that name throughout instead — match the file, don't rename its fixtures.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/usage.test.ts`
Expected: FAIL — `fetchAgentSkills` and `recordSkillRuns` are not exported.

- [ ] **Step 3: Replace `fetchAgentSkill` with composition**

In `apps/agent-orchestrator/src/usage.ts`, replace the `AgentSkill` interface and `fetchAgentSkill` with:

```ts
/**
 * Composition caps. These are a prompt budget, not a product limit: every
 * composed body is injected into the system prompt on every turn, so an
 * unbounded skill set silently eats the context window the conversation needs.
 * The API enforces the same two numbers at attach time (see the attach route),
 * where exceeding them is a visible rejection rather than a silent drop.
 */
export const MAX_ATTACHED_SKILLS = 8
export const MAX_COMPOSED_SKILL_CHARS = 24_000

export interface ComposedAgentSkills {
  /** Every active skill's body, composed in attachment order. Null when none. */
  systemPrompt: string | null
  /** Every install that made it into the prompt — all of them get a run count. */
  installIds: string[]
  /** Skills excluded by a cap. Non-empty only for agents that predate the caps. */
  droppedNames: string[]
}

/**
 * Every active skill attached to the agent, composed into one prompt section.
 *
 * This used to be `LIMIT 1`, which meant only the newest attached skill ever
 * reached the model and attaching a second one silently switched the first
 * off. Ordering is `created_at ASC` — attachment order — so the composed
 * prompt is stable from turn to turn rather than reshuffling under the model.
 */
export async function fetchAgentSkills(agentId: string): Promise<ComposedAgentSkills> {
  const p = getPool()
  const res = await p.query<{ name: string; system_prompt: string | null; install_id: string | null }>(
    `SELECT name, system_prompt, install_id FROM agent_skills
     WHERE agent_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [agentId],
  )

  const parts: string[] = []
  const installIds: string[] = []
  const droppedNames: string[] = []
  let budget = MAX_COMPOSED_SKILL_CHARS

  for (const row of res.rows) {
    const body = row.system_prompt?.trim()
    if (!body) continue
    if (installIds.length >= MAX_ATTACHED_SKILLS || body.length > budget) {
      droppedNames.push(row.name)
      continue
    }
    budget -= body.length
    parts.push(`## Skill: ${row.name}\n\n${body}`)
    if (row.install_id) installIds.push(row.install_id)
  }

  if (droppedNames.length > 0) {
    // Loud on purpose: these skills are attached but not running, and nothing
    // in the UI says so. Attach-time rejection prevents new cases; this only
    // fires for agents that were over the cap before the caps existed.
    console.error(`[skills] agent=${agentId} dropped ${droppedNames.length} skill(s) over cap: ${droppedNames.join(', ')}`)
  }

  return {
    systemPrompt: parts.length > 0 ? parts.join('\n\n') : null,
    installIds,
    droppedNames,
  }
}
```

Note the query no longer selects `tools`/`config`: nothing read them. `chatStream.ts` used only `systemPrompt` and `installId`, and `agent.ts` only `systemPrompt`. Removing them from the projection is not scope creep — it is not carrying dead columns through a rewritten function.

Then replace `recordSkillRun` with a fan-out, keeping the existing single-install query as its body:

```ts
/**
 * One run per composed install per chat message. Sequential rather than
 * parallel: this is fire-and-forget bookkeeping behind a live stream, and a
 * burst of concurrent writes is not worth the pool pressure.
 */
export async function recordSkillRuns(installIds: string[], tenantId: string): Promise<void> {
  const p = getPool()
  for (const installId of installIds) {
    await p.query(
      `UPDATE skill_installs SET run_count = run_count + 1, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [installId, tenantId],
    )
  }
}
```

- [ ] **Step 4: Update both call sites**

`apps/agent-orchestrator/src/routes/chatStream.ts` — change the import on line 12 from `fetchAgentSkill, ... recordSkillRun` to `fetchAgentSkills, ... recordSkillRuns`, then the call site at ~251:

```ts
    const [agentSkills, agentName, personaPersonality, agentModelSelection] = await Promise.all([
      fetchAgentSkills(agentId),
```

and ~260:

```ts
    if (agentSkills.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkills.systemPrompt)
    }
    // One run per composed install per chat message. Fire-and-forget: a counter
    // write must never break or delay the stream.
    if (agentSkills.installIds.length > 0) {
      recordSkillRuns(agentSkills.installIds, tenantId)
        .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRuns failed:`, (err as Error).message))
    }
```

`apps/agent-orchestrator/src/mastra/agent.ts:63-66` — the background-task path, which must stay at parity with chat:

```ts
    fetchAgentSkills(config.agentId),
```
```ts
  if (agentSkill.systemPrompt) requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
```

(keep the local variable name that destructuring already uses; only the function and the property access change.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/usage.test.ts src/mastra/agent.test.ts`
Expected: PASS. `agent.test.ts` asserts the background path sets `agentSystemPrompt` — if it mocks `fetchAgentSkill` by name, update the mock to `fetchAgentSkills` returning `{ systemPrompt: '...', installIds: [], droppedNames: [] }`.

- [ ] **Step 6: Run the full orchestrator suite and type-check**

Run: `cd apps/agent-orchestrator && pnpm test && pnpm exec tsc --noEmit`
Expected: only the known pre-existing `tasks-execute.test.ts` failure. Any other failure is a call site you missed — `grep -rn "fetchAgentSkill\b" src` should return nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts \
        apps/agent-orchestrator/src/usage.test.ts \
        apps/agent-orchestrator/src/routes/chatStream.ts \
        apps/agent-orchestrator/src/mastra/agent.ts
git commit -m "fix(skills): compose every attached skill into the prompt

fetchAgentSkill read LIMIT 1, so only the newest attached skill ever
reached the model and attaching a second one silently switched the first
off. Compose them all in attachment order instead, bounded by a count and
a character budget so a large skill set cannot eat the context window, and
count a run against every composed install rather than one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 2: Reject an attach that would exceed the caps

Composition drops overflow silently by necessity — it runs mid-turn with nobody to tell. Attach is a request with a caller, so it refuses instead.

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agent-skills.ts` (the POST `/:agentId/skills` handler, around the `db.insert(agentSkills)` at ~145)
- Test: `products/agent-platform/packages/api/__tests__/agent-skills.test.ts`

**Interfaces:**
- Consumes: the cap values from Task 1 — re-declared here, not imported (the orchestrator is not a dependency of the API Lambda).
- Produces: HTTP 409 `{ code: 'SKILL_BUDGET_EXCEEDED' }` when an attach would exceed either cap. Task 6's tool surfaces this message to the user.

- [ ] **Step 1: Write the failing tests**

Read the existing `agent-skills.test.ts` for its db-mock shape and reuse it. Add:

```ts
  it('refuses an attach that would exceed the attached-skill count cap', async () => {
    // 8 skills already attached — the 9th must be refused, not truncated later.
    mockActiveSkills(Array.from({ length: 8 }, (_, i) => ({ name: `skill-${i}`, systemPrompt: 'body' })));

    const res = await postAttach({ name: 'ninth', systemPrompt: 'body' });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
  });

  it('refuses an attach that would exceed the composed character budget', async () => {
    mockActiveSkills([{ name: 'huge', systemPrompt: 'x'.repeat(23_900) }]);

    const res = await postAttach({ name: 'small', systemPrompt: 'y'.repeat(500) });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
  });

  it('allows an attach that fits inside both caps', async () => {
    mockActiveSkills([{ name: 'one', systemPrompt: 'short' }]);

    const res = await postAttach({ name: 'two', systemPrompt: 'also short' });

    expect(res.status).toBe(201);
  });
```

Write `mockActiveSkills` and `postAttach` as local helpers in the file, shaped to whatever db mock the file already uses — the point is that the handler sees N existing active rows for the agent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run agent-skills.test.ts`
Expected: FAIL — the over-cap attaches return 201.

- [ ] **Step 3: Enforce the caps before the insert**

In `products/agent-platform/packages/api/routes/agent-skills.ts`, near the top:

```ts
// Mirrors MAX_ATTACHED_SKILLS / MAX_COMPOSED_SKILL_CHARS in the orchestrator's
// usage.ts. Deliberately duplicated rather than shared: the orchestrator is not
// a dependency of this Lambda, and a shared package for two integers would cost
// more than it saves. If either number changes, change both.
const MAX_ATTACHED_SKILLS = 8;
const MAX_COMPOSED_SKILL_CHARS = 24_000;
```

Then immediately before the `db.insert(agentSkills)` call — after `systemPrompt` is resolved, so the real body length is known:

```ts
        const active = await db.select({ name: agentSkills.name, systemPrompt: agentSkills.systemPrompt })
            .from(agentSkills)
            .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.tenantId, tenantId), eq(agentSkills.status, 'active')));

        // Refused rather than truncated: the prompt budget is real, and half a
        // skill in the prompt is worse than none. Failing here makes it visible
        // to whoever is attaching instead of surfacing later as bad output.
        const composedChars = active.reduce((n, s) => n + (s.systemPrompt?.length ?? 0), 0);
        if (active.length >= MAX_ATTACHED_SKILLS) {
            return c.json({
                error: `This agent already has the maximum of ${MAX_ATTACHED_SKILLS} skills attached. Detach one first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
        }
        if (composedChars + systemPrompt.length > MAX_COMPOSED_SKILL_CHARS) {
            return c.json({
                error: `Attaching this skill would exceed the agent's prompt budget of ${MAX_COMPOSED_SKILL_CHARS} characters. Detach a skill first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
        }
```

Check the file's existing imports for `and`/`eq` before adding them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run agent-skills.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/agent-skills.ts \
        products/agent-platform/packages/api/__tests__/agent-skills.test.ts
git commit -m "feat(skills): refuse an attach that exceeds the agent prompt budget

Composition has to drop overflow silently — it runs mid-turn with nobody
to tell. An attach has a caller, so it refuses instead, naming the cap and
what to do about it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 3: A non-priced mode for the confirmation gate

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts:9-42`
- Test: `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an added optional parameter —
  ```ts
  confirmGenerationOrDecline(
    execContext: any, resourceType: string, subject: string, label: string,
    opts?: { alwaysAsk?: boolean },
  ): Promise<{ confirmed: boolean; reason?: 'CONFIRM_BUSY'; declineReason?: string }>
  ```
  Task 6 calls it with `{ alwaysAsk: true }`.

- [ ] **Step 1: Write the failing tests**

Read the existing `confirmGeneration.test.ts` for its `execContext` fixture and mock setup, then add:

```ts
  it('asks an unlimited tenant when alwaysAsk is set', async () => {
    isUnlimitedMock.mockResolvedValue(true)
    const ctx = makeExecContext()   // existing helper in this file

    const promise = confirmGenerationOrDecline(ctx, 'skill_creation', 'create', 'Create skill', { alwaysAsk: true })
    // The card was sent rather than auto-approved.
    expect(sendEventMock).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ resourceType: 'skill_creation' }))
    resolvePendingConfirmation(true)  // existing helper
    await expect(promise).resolves.toMatchObject({ confirmed: true })
  })

  it('asks when no credit rate matches and alwaysAsk is set', async () => {
    isUnlimitedMock.mockResolvedValue(false)
    resolveRateMock.mockResolvedValue(null)
    const ctx = makeExecContext()

    const promise = confirmGenerationOrDecline(ctx, 'skill_creation', 'create', 'Create skill', { alwaysAsk: true })
    expect(sendEventMock).toHaveBeenCalled()
    resolvePendingConfirmation(false)
    await expect(promise).resolves.toMatchObject({ confirmed: false })
  })

  // Auto-allow is an explicit user setting, and alwaysAsk does not override it.
  it('still honours allowMode auto when alwaysAsk is set', async () => {
    const ctx = makeExecContext({ allowMode: 'auto' })
    await expect(confirmGenerationOrDecline(ctx, 'skill_creation', 'create', 'Create skill', { alwaysAsk: true }))
      .resolves.toEqual({ confirmed: true })
    expect(sendEventMock).not.toHaveBeenCalled()
  })

  // Without the flag, nothing about the existing spend-gate behaviour moves.
  it('still auto-approves an unlimited tenant without alwaysAsk', async () => {
    isUnlimitedMock.mockResolvedValue(true)
    await expect(confirmGenerationOrDecline(makeExecContext(), 'image_generation', 'x', 'y'))
      .resolves.toEqual({ confirmed: true })
    expect(sendEventMock).not.toHaveBeenCalled()
  })
```

If the file has no `makeExecContext`/`resolvePendingConfirmation` helpers, build the context and resolve the pending promise the way the existing tests in that file already do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/confirmGeneration.test.ts`
Expected: FAIL — the first two auto-approve without sending a card.

- [ ] **Step 3: Add the flag**

In `confirmGeneration.ts`, extend the signature and guard both early returns:

```ts
export async function confirmGenerationOrDecline(
  execContext: any,
  resourceType: string,
  subject: string,
  label: string,
  opts: { alwaysAsk?: boolean } = {},
): Promise<{ confirmed: boolean; reason?: 'CONFIRM_BUSY'; declineReason?: string }> {
```

```ts
  // Both early returns below exist because this is a *spend* gate: an unlimited
  // tenant has nothing to approve, and an unpriced resource costs nothing.
  // alwaysAsk is for writes that are free but still need a human — creating a
  // skill costs a fraction of a cent and changes what the agent does forever.
  // Seeding a ¢0 credit_rates row to force the card would put a non-price in a
  // pricing table, where someone would later tidy it away and silently disable
  // the gate.
  if (!opts.alwaysAsk && await isUnlimitedFn(tenantId)) {
    return { confirmed: true }
  }
```

Leave the `allowMode === 'auto'` check exactly as it is — it sits between the two and must keep applying. Then:

```ts
  if (!opts.alwaysAsk) {
    const rate = await resolveRate(resourceType, subject)
    if (!rate) {
      return { confirmed: true }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/confirmGeneration.test.ts`
Expected: PASS, all pre-existing cases included.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts \
        apps/agent-orchestrator/src/mastra/tools/confirmGeneration.test.ts
git commit -m "feat(confirm): add a non-priced alwaysAsk mode to the confirm gate

The gate short-circuits for unlimited tenants and unpriced resources
because it was built to gate spend. Creating a skill is free but still
needs a human, so it needs a way to ask that does not involve inventing a
price for it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 4: The internal skill-creation route

**Files:**
- Create: `products/agent-platform/packages/api/routes/internal/skills.ts`
- Modify: `products/agent-platform/packages/api/index.ts:89-99` (`mountInternalRoutes`)
- Test: `products/agent-platform/packages/api/__tests__/internal.skills.test.ts`

**Interfaces:**
- Consumes: `isAuthorized` from `./tasks.auth`; `createVersionAndEnqueue` and `slugify` from `../skills` (export them if they are module-private); `resolveUserPermissions` + `hasPermission` from `@serverless-saas/permissions`; `IdempotencyStore` from `@serverless-saas/idempotency`.
- Produces: `POST /api/v1/internal/skills` accepting
  ```ts
  { tenantId, userId, agentId, conversationId, messageId, name, description?, body }
  ```
  and returning `202 { data: { skillId, installId } }`. The enqueued `skill.import` message carries `attachToAgentId` — Task 5 consumes that; Task 6 calls this route.

- [ ] **Step 1: Write the failing tests**

Create `products/agent-platform/packages/api/__tests__/internal.skills.test.ts`, following `__tests__/skills.test.ts` for the db/queue mock style:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

const resolveUserPermissionsMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/permissions', async () => {
  const actual = await vi.importActual<typeof import('@serverless-saas/permissions')>('@serverless-saas/permissions');
  return { ...actual, resolveUserPermissions: resolveUserPermissionsMock };
});

const acquireMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/idempotency', () => ({
  IdempotencyStore: vi.fn().mockImplementation(function StoreMock() {
    return { acquire: acquireMock, complete: completeMock };
  }),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const BODY = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nOpen with the client name.';

function payload(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, userId: USER, agentId: AGENT,
    conversationId: 'conv-1', messageId: 'msg-1',
    name: 'Bid Writer', description: 'Writes bids', body: BODY, ...over,
  };
}

async function post(body: unknown, key = 'test-key') {
  const { internalSkillsRoute } = await import('../routes/internal/skills');
  const app = new Hono();
  app.route('/internal/skills', internalSkillsRoute);
  return app.request('/internal/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': key },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_KEY = 'test-key';
    process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/queue';
    resolveUserPermissionsMock.mockResolvedValue([{ resource: 'skills', action: 'create' }]);
    acquireMock.mockResolvedValue(true);
    // Quota query returns a low count by default.
    dbMock.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) });
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => [{ id: 'row-1', ...data }],
        catch: () => {},
      }),
    }));
  });

  it('rejects a request with the wrong service key', async () => {
    const res = await post(payload(), 'wrong-key');
    expect(res.status).toBe(401);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a user without skills:create', async () => {
    resolveUserPermissionsMock.mockResolvedValue([{ resource: 'skills', action: 'read' }]);
    const res = await post(payload());
    expect(res.status).toBe(403);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a user with no membership in the tenant', async () => {
    resolveUserPermissionsMock.mockResolvedValue(null);
    const res = await post(payload());
    expect(res.status).toBe(403);
  });

  it('creates the skill and enqueues an authored import carrying attachToAgentId', async () => {
    const res = await post(payload());
    expect(res.status).toBe(202);
    const [, message] = publishToQueueMock.mock.calls[0];
    expect(message.type).toBe('skill.import');
    expect(message.source).toEqual({ type: 'authored', body: BODY });
    expect(message.attachToAgentId).toBe(AGENT);
    expect(message.tenantId).toBe(TENANT);
  });

  it('returns 429 once the tenant hits the daily cap', async () => {
    dbMock.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ count: 20 }]) }) });
    const res = await post(payload());
    expect(res.status).toBe(429);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  // A retried tool call must not produce a second skill; the slug's random
  // suffix means no unique constraint would catch it.
  it('refuses a duplicate when the idempotency claim is already held', async () => {
    acquireMock.mockResolvedValue(false);
    const res = await post(payload());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DUPLICATE_REQUEST');
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a body over 64KB', async () => {
    const res = await post(payload({ body: 'x'.repeat(65_537) }));
    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a payload missing tenantId', async () => {
    const res = await post(payload({ tenantId: undefined }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run internal.skills.test.ts`
Expected: FAIL — `../routes/internal/skills` does not exist.

- [ ] **Step 3: Export what the route needs from the public skills route**

In `products/agent-platform/packages/api/routes/skills.ts`, add `export` to `slugify` and `createVersionAndEnqueue` if they are not already exported, and extend `createVersionAndEnqueue`'s params with an optional `attachToAgentId` that it forwards into the queue message:

```ts
async function createVersionAndEnqueue(params: {
  tenantId: string;
  skillId: string;
  version: number;
  source: z.infer<typeof sourceSchema>;
  attachToAgentId?: string;
}) {
```
```ts
    await publishToQueue(queueUrl, {
      type: 'skill.import', tenantId, skillId, skillVersionId: versionRow.id, version, source,
      ...(params.attachToAgentId ? { attachToAgentId: params.attachToAgentId } : {}),
    });
```

Spreading conditionally keeps the message shape byte-identical for every existing caller, so the worker's current tests stay valid.

- [ ] **Step 4: Write the route**

Create `products/agent-platform/packages/api/routes/internal/skills.ts`:

```ts
import { Hono } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { skills, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission, resolveUserPermissions } from '@serverless-saas/permissions';
import { IdempotencyStore } from '@serverless-saas/idempotency';
import { getCacheClient } from '@serverless-saas/cache';
import { isAuthorized } from './tasks.auth';
import { slugify, createVersionAndEnqueue } from '../skills';
import type { AppEnv } from '@serverless-saas/types';

export const internalSkillsRoute = new Hono<AppEnv>();

/** Chat makes skill creation cheap; nothing else bounds it. There is no
 *  `skills` entitlement in the features seed, so this is the only ceiling. */
const DAILY_TENANT_LIMIT = 20;

const schema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  body: z.string().min(1).max(65_536),
});

// Creating a skill from inside a conversation. The service key authenticates
// the *orchestrator*, never the person on the other end of the chat — so the
// acting user's own permissions are resolved and enforced here. Without that, a
// viewer-role user who cannot create a skill in the dashboard could create one
// by asking an agent to.
internalSkillsRoute.post('/', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  const { tenantId, userId, agentId, conversationId, messageId, name, description, body } = parsed.data;

  const permissions = await resolveUserPermissions(db, tenantId, userId);
  if (!permissions || !hasPermission(permissions, 'skills', 'create')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skills)
      .where(and(eq(skills.ownerTenantId, tenantId), gte(skills.createdAt, since)));
    if (count >= DAILY_TENANT_LIMIT) {
      return c.json({ error: `Daily limit of ${DAILY_TENANT_LIMIT} created skills reached.`, code: 'QUOTA_EXCEEDED' }, 429);
    }

    // A retried tool call must not create a second skill. Slugs carry a random
    // suffix, so the (ownerTenantId, slug) unique constraint never catches this.
    const store = new IdempotencyStore(getCacheClient());
    const claimed = await store.acquire(`skill-create:${conversationId}:${messageId}:${slugify(name)}`);
    if (!claimed) {
      return c.json({ error: 'This skill was already created for that message.', code: 'DUPLICATE_REQUEST' }, 409);
    }

    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
    const [skill] = await db.insert(skills).values({
      ownerTenantId: tenantId, name, slug, description: description ?? null,
      visibility: 'private', isOfficial: false, latestVersion: 0, createdBy: userId,
    }).returning();

    await createVersionAndEnqueue({
      tenantId, skillId: skill.id, version: 1,
      source: { type: 'authored', body },
      attachToAgentId: agentId,
    });

    // Installed here rather than by a second user action: a skill created
    // mid-conversation is meant to be in use, and the worker's attach step
    // needs an install row to point agent_skills.install_id at.
    const [install] = await db.insert(skillInstalls).values({
      tenantId, skillId: skill.id, installedVersion: 1, status: 'active',
    }).returning();

    db.insert(auditLog).values({
      tenantId, actorId: userId, actorType: 'human', action: 'skill_created',
      resource: 'skill', resourceId: skill.id,
      metadata: { name, sourceType: 'authored', origin: 'conversation', conversationId, agentId },
      traceId: c.get('traceId') ?? '',
    }).catch(() => {});

    return c.json({ data: { skillId: skill.id, installId: install.id } }, 202);
  } catch (err) {
    console.error('Failed to create skill from conversation:', err);
    return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

Check `@serverless-saas/cache`'s real export name for obtaining a client before finishing — if it is not `getCacheClient`, use whatever `packages/foundation/cache/src/index.ts` exports and note it in your report.

- [ ] **Step 5: Mount it**

In `products/agent-platform/packages/api/index.ts`, inside `mountInternalRoutes`:

```ts
    internalApi.route('/internal/skills', internalSkillsRoute);
```

with the matching import at the top of the file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run internal.skills.test.ts && pnpm test`
Expected: PASS, whole package.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/api/routes/internal/skills.ts \
        products/agent-platform/packages/api/routes/skills.ts \
        products/agent-platform/packages/api/index.ts \
        products/agent-platform/packages/api/__tests__/internal.skills.test.ts
git commit -m "feat(skills): internal route for creating a skill from a conversation

The public route gets tenant, user and permissions from middleware this
one does not have, so it resolves the acting user's permissions itself —
the service key authenticates the orchestrator, never the person chatting.
Adds the two ceilings nothing else provides: a daily per-tenant cap, and
an idempotency claim so a retried tool call cannot create a second skill.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 5: The worker attaches the skill once it is ready

**Files:**
- Modify: `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts` (payload type, and the success path after the version reaches `ready`)
- Test: `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`

**Interfaces:**
- Consumes: `attachToAgentId` on the `skill.import` message (Task 4).
- Produces: an `agent_skills` row with `systemPrompt` = the parsed manifest body, `version` = the imported version, `installId` = the tenant's active install for that skill.

- [ ] **Step 1: Write the failing tests**

Add to `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`, matching its existing mock style:

```ts
  it('attaches the skill to the agent after the version is ready', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: d\n---\n\nOpen with the client name.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('agent_skills');
    const params = dbMock.execute.mock.calls.flatMap(([q]) => sqlParams(q));
    expect(params).toContain('agent-1');
    // The body the agent runs on is the parsed manifest body, not the raw file.
    expect(params.some((p) => String(p).includes('Open with the client name.'))).toBe(true);
  });

  it('does not attach when the payload carries no attachToAgentId', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: d\n---\n\nBody.' },
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).not.toContain('agent_skills');
  });

  it('does not attach when the import fails', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: 'no frontmatter here' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'failed'");
    expect(executed).not.toContain('agent_skills');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/worker-handlers && pnpm exec vitest run skillImport.test.ts`
Expected: FAIL — no `agent_skills` write happens.

- [ ] **Step 3: Implement the attach**

In `skillImport.ts`, extend the payload interface:

```ts
export interface SkillImportPayload {
  tenantId: string;
  skillId: string;
  skillVersionId: string;
  version: number;
  source: SkillImportSource;
  /** Set only by the in-conversation create path: attach the skill to this
   *  agent once the version is ready. */
  attachToAgentId?: string;
}
```

Then, in `handleSkillImport`, after the statement that flips the version to `ready` and inside the same `try` (so a failed import never reaches it):

```ts
    // Attaching here rather than polling from the caller: this is the moment
    // the version becomes usable, the parsed body is already in hand, and the
    // attach survives the user closing the tab.
    //
    // agent_skills is unique on (agent_id, tenant_id, name, version) — the
    // version must be the one just imported, or a legitimate re-attach of a
    // later version collides with this row.
    if (attachToAgentId) {
      await db.execute(sql`
        INSERT INTO agent_skills (agent_id, tenant_id, name, system_prompt, tools, version, status, install_id)
        SELECT ${attachToAgentId}::uuid, ${tenantId}::uuid, ${manifest.name}, ${manifestWithBody.body}, '{}', ${version},
               'active', si.id
        FROM skill_installs si
        WHERE si.skill_id = ${skillId}::uuid AND si.tenant_id = ${tenantId}::uuid AND si.status = 'active'
        ON CONFLICT (agent_id, tenant_id, name, version) DO NOTHING
      `);
    }
```

Destructure `attachToAgentId` alongside the other payload fields at the top of the function. `ON CONFLICT DO NOTHING` makes an SQS redelivery — which is at-least-once — idempotent at the row level.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/worker-handlers && pnpm test`
Expected: PASS, whole package including the pre-existing zip/github/url/authored tests.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/worker-handlers/handlers/skillImport.ts \
        products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts
git commit -m "feat(skills): attach a conversation-created skill once it is ready

Attach cannot happen at create time — the version is pending until this
handler finishes, and attaching a pending version is rejected. Doing it
here means no polling, no timeout to tune, and an attach that survives the
user closing the tab. ON CONFLICT DO NOTHING keeps an SQS redelivery from
duplicating the row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 6: The `create_skill` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/createSkill.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/createSkill.test.ts`
- Modify: wherever tools are registered for the platform agent (find it with `grep -rn "generateVideoTool\|confirmGeneration" apps/agent-orchestrator/src/mastra/*.ts`)

**Interfaces:**
- Consumes: `confirmGenerationOrDecline(..., { alwaysAsk: true })` (Task 3); `POST /api/v1/internal/skills` (Task 4); `filterPII` from `../../pii-filter.js`; `parseSkillManifest`-equivalent validation (implemented locally — the worker's copy is not importable from here).
- Produces: `createSkillTool`, a Mastra tool named `create_skill`.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent-orchestrator/src/mastra/tools/createSkill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('./confirmGeneration.js', () => ({ confirmGenerationOrDecline: confirmMock }))

const fetchMock = vi.hoisted(() => vi.fn())

const VALID_BODY = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nOpen with the client name.'

function execContext(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    tenantId: 'tenant-1', userId: 'user-1', agentId: 'agent-1',
    conversationId: 'conv-1', sessionId: 'sess-1',
    sendEvent: vi.fn(), ...over,
  }
  return { requestContext: { get: (k: string) => values[k] } }
}

async function run(args: Record<string, unknown>, ctx = execContext()) {
  const { createSkillTool } = await import('./createSkill.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (createSkillTool as any).execute({ context: args, ...ctx })
}

describe('create_skill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    process.env.INTERNAL_SERVICE_KEY = 'test-key'
    process.env.API_BASE_URL = 'https://api.test'
    confirmMock.mockResolvedValue({ confirmed: true })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { skillId: 'skill-1', installId: 'install-1' } }), { status: 202 }))
  })

  it('rejects a body with no frontmatter without calling the API', async () => {
    const result = await run({ name: 'Bid Writer', body: 'just prose' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/frontmatter/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body missing the description field', async () => {
    const result = await run({ name: 'Bid Writer', body: '---\nname: x\n---\n\nBody.' })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body over 64KB', async () => {
    const result = await run({ name: 'Big', body: `---\nname: a\ndescription: b\n---\n\n${'x'.repeat(65_537)}` })
    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Without a live SSE session the confirm gate auto-approves, which would mean
  // unattended writes into the tenant's library.
  it('refuses when there is no live session', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY }, execContext({ sendEvent: undefined }))
    expect(result.success).toBe(false)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for confirmation with alwaysAsk and creates on approval', async () => {
    const result = await run({ name: 'Bid Writer', description: 'Writes bids', body: VALID_BODY })

    expect(confirmMock).toHaveBeenCalledWith(
      expect.anything(), 'skill_creation', 'create', expect.stringContaining('Bid Writer'),
      { alwaysAsk: true },
    )
    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.test/api/v1/internal/skills')
    expect(init.headers['x-internal-service-key']).toBe('test-key')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', agentId: 'agent-1', name: 'Bid Writer' })
  })

  // The reply that creates a skill cannot be shaped by it: skills load once at
  // stream start. Saying so is the difference between "working" and "broken".
  it('tells the user the skill applies from their next message', async () => {
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.message).toMatch(/next message/i)
  })

  it('returns a terminal result when the user declines', async () => {
    confirmMock.mockResolvedValue({ confirmed: false })
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a terminal result when another confirmation is pending', async () => {
    confirmMock.mockResolvedValue({ confirmed: false, reason: 'CONFIRM_BUSY' })
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(false)
  })

  it('surfaces a quota rejection as a plain message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'QUOTA_EXCEEDED' }), { status: 429 }))
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/limit/i)
  })

  it('surfaces a permission rejection as a plain message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'INSUFFICIENT_PERMISSIONS' }), { status: 403 }))
    const result = await run({ name: 'Bid Writer', body: VALID_BODY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission|role/i)
  })

  it('passes PII detections into the confirmation label', async () => {
    const withEmail = '---\nname: a\ndescription: b\n---\n\nMail ada@example.com about it.'
    await run({ name: 'Bid Writer', body: withEmail })
    expect(confirmMock.mock.calls[0][3]).toMatch(/personal|detected/i)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/createSkill.test.ts`
Expected: FAIL — `./createSkill.js` does not exist.

- [ ] **Step 3: Write the tool**

Read `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts` first for the `createTool` shape, `execContext` reads, and error-return conventions this repo uses. Then create `createSkill.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { confirmGenerationOrDecline } from './confirmGeneration.js'
import { filterPII } from '../../pii-filter.js'

const MAX_BODY_BYTES = 65_536
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface CreateSkillResult {
  success: boolean
  message?: string
  error?: string
  /** False means the agent must not call this tool again for this request. */
  retryable?: boolean
  skillId?: string
}

/**
 * Validates the frontmatter contract `parseSkillManifest` enforces in the
 * import worker. Checked here so a malformed draft is a tool error the agent
 * can fix on the spot, rather than a `failed` version row the user discovers
 * minutes later on the Skills page.
 */
function validateSkillBody(body: string): string | null {
  const match = FRONTMATTER_RE.exec(body)
  if (!match) return 'SKILL.md must start with a --- YAML frontmatter block'
  const frontmatter = match[1]
  if (!/^name:\s*\S/m.test(frontmatter)) return "SKILL.md frontmatter is missing required field 'name'"
  if (!/^description:\s*\S/m.test(frontmatter)) return "SKILL.md frontmatter is missing required field 'description'"
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return `SKILL.md must be under ${MAX_BODY_BYTES} bytes`
  return null
}

export const createSkillTool = createTool({
  id: 'create_skill',
  description: `Save a reusable skill for this workspace from what you have learned in this conversation.

Call this ONLY when the user explicitly asks for it — "save that as a skill", "/create-skill", "remember this as a skill". Never call it on your own initiative.

You write the file. \`body\` must be a complete SKILL.md:
- Start with a YAML frontmatter block delimited by --- lines, containing name (lowercase kebab-case) and description (one sentence saying when an agent should use this skill).
- After the closing ---, write instructions addressed to the agent that will follow them: when the skill applies, concrete steps, exact phrasings and formats, and what to avoid.
- Never invent facts about the user's business. Where a specific is unknown, tell the agent to ask.

The user is shown the draft and must approve it. The skill applies from their next message, not this reply.`,
  inputSchema: z.object({
    name: z.string().min(1).max(100).describe('Human-readable skill name, e.g. "Bid Writer"'),
    description: z.string().max(2000).optional().describe('One line on what the skill is for'),
    body: z.string().min(1).describe('The complete SKILL.md, frontmatter included'),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async ({ context, ...execContext }: any): Promise<CreateSkillResult> => {
    const { name, description, body } = context as { name: string; description?: string; body: string }

    const invalid = validateSkillBody(body)
    if (invalid) return { success: false, error: invalid, retryable: true }

    const ctx = (execContext as any)?.requestContext
    const tenantId = ctx?.get('tenantId') as string | undefined
    const userId = ctx?.get('userId') as string | undefined
    const agentId = ctx?.get('agentId') as string | undefined
    const conversationId = ctx?.get('conversationId') as string | undefined
    const sendEvent = ctx?.get('sendEvent')

    // No live session means the confirm gate would auto-approve — see its
    // sendEvent guard. For a spend gate that is a documented hole; for a write
    // into the tenant's skill library it would mean unattended creation.
    if (!sendEvent || !tenantId || !userId || !agentId || !conversationId) {
      return {
        success: false,
        error: 'Skills can only be created from a live chat session.',
        retryable: false,
      }
    }

    // filterPII covers India identity patterns (email, phone, Aadhaar, PAN,
    // passport, voter id) and nothing credential-shaped. It informs the human
    // rather than blocking — the confirmation card is the actual control.
    const pii = filterPII(body)
    const piiNote = pii.detections.length > 0
      ? ` — personal data detected: ${[...new Set(pii.detections.map((d) => d.type))].join(', ')}`
      : ''

    const confirmation = await confirmGenerationOrDecline(
      execContext,
      'skill_creation',
      'create',
      `Create skill "${name}"${piiNote}`,
      { alwaysAsk: true },
    )
    if (!confirmation.confirmed) {
      return {
        success: false,
        error: confirmation.reason === 'CONFIRM_BUSY'
          ? 'Another confirmation is already open — finish that one first.'
          : 'The user declined, so nothing was created.',
        retryable: false,
      }
    }

    const messageId = ctx?.get('sessionId') as string | undefined ?? conversationId

    try {
      const res = await fetch(`${process.env.API_BASE_URL}/api/v1/internal/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ tenantId, userId, agentId, conversationId, messageId, name, description, body }),
      })

      if (!res.ok) {
        const code = (await res.json().catch(() => ({}))).code as string | undefined
        const error =
          code === 'QUOTA_EXCEEDED' ? "This workspace has reached today's limit for creating skills."
          : code === 'INSUFFICIENT_PERMISSIONS' ? 'Your role does not allow creating skills.'
          : code === 'DUPLICATE_REQUEST' ? 'That skill was already created.'
          : 'The skill could not be saved.'
        return { success: false, error, retryable: false }
      }

      const { data } = await res.json() as { data: { skillId: string } }
      return {
        success: true,
        skillId: data.skillId,
        // Skills load once at stream start, so this reply cannot use it.
        message: `Saved "${name}" as a skill and attached it to this agent. It takes effect from your next message.`,
      }
    } catch (err) {
      console.error('[create_skill] failed:', (err as Error).message)
      return { success: false, error: 'The skill could not be saved.', retryable: false }
    }
  },
})
```

Check `filterPII`'s real return shape in `apps/agent-orchestrator/src/pii-filter.ts` (the `PiiFilterResult` interface) and adjust the `pii.detections` access if the field differs.

- [ ] **Step 4: Register the tool**

Find the platform agent's tool registry:

```bash
grep -rn "generateVideoTool" apps/agent-orchestrator/src/mastra/*.ts
```

Add `createSkillTool` to the same map, following the surrounding style exactly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/createSkill.test.ts`
Expected: PASS, all twelve cases.

- [ ] **Step 6: Run the full orchestrator suite and type-check**

Run: `cd apps/agent-orchestrator && pnpm test && pnpm exec tsc --noEmit`
Expected: only the known `tasks-execute.test.ts` failure.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/createSkill.ts \
        apps/agent-orchestrator/src/mastra/tools/createSkill.test.ts \
        apps/agent-orchestrator/src/mastra/
git commit -m "feat(skills): let an agent create a skill during a conversation

The moment a skill is worth writing is mid-conversation, while the lesson
is still in front of the agent. The agent writes SKILL.md itself rather
than delegating to a second model that would only receive a lossy retelling
of context this one already holds. Frontmatter is validated before the
write so a bad draft is a fixable tool error, and the tool refuses outright
without a live session rather than inheriting the confirm gate's
auto-approve.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E4VzkrBL8TTj3vaBh3aVEw"
```

---

### Task 7: Verify, then hand off the deploy

No product code. The three surfaces deploy separately and a green suite proves none of it.

- [ ] **Step 1: Run every touched package's suite**

```bash
pnpm --filter agent-orchestrator test
pnpm --filter @serverless-saas/agent-api test
pnpm --filter @serverless-saas/agent-worker-handlers test
```

Expected: all pass except the known `tasks-execute.test.ts`. Confirm any other failure also fails at the branch base before treating it as pre-existing.

- [ ] **Step 2: Build**

```bash
pnpm build
```

Expected: exit 0. A stale `dist/` in a product package makes `sam deploy` ship old compiled JS while reporting success.

- [ ] **Step 3: Count the agents the composition change affects**

This is the only change that alters agents nobody edited. Run against dev, read-only:

```sql
SELECT agent_id, count(*) AS attached
FROM agent_skills WHERE status = 'active'
GROUP BY agent_id HAVING count(*) > 1
ORDER BY attached DESC;
```

Record the result in your report. Every agent in that list currently runs on one skill and will start running on all of them. If the list is long, or any agent's skills contradict each other, say so plainly — the recommendation is then to deploy the orchestrator (Task 1) on its own and watch before the rest.

- [ ] **Step 4: Write the deploy handoff**

Report, in this order:

1. `sam deploy --config-file samconfig.dev.toml` — the internal route and the worker's attach branch. No migration; this feature adds no schema.
2. `pm2 restart agent-orchestrator` on the GCP VM, by hand — composition, the gate change, and the tool all live there. `./deploy.sh` does not touch it. SSH to the VM has failed from this sandbox before, so this step is likely the user's.
3. No web deploy: nothing in `apps/web` changed.

Note that composition takes effect the instant the orchestrator restarts, so step 3's query belongs before that restart.

- [ ] **Step 5: Manual smoke test (user-run, after deploy)**

Give the user this list:
- In a chat, teach the agent something specific, then say "save that as a skill". A confirmation card appears with the drafted SKILL.md.
- Decline it: the agent reports it wasn't created and does not retry.
- Ask again and approve: the skill appears on the Skills page, goes `pending` → `v1`, and shows as installed.
- Send another message: the agent's behaviour reflects the new skill (it should not in the reply that created it).
- Open the agent's detail page: the new skill is attached.
- Attach skills until the 9th: it is refused with the budget message rather than silently ignored.
- An agent with two attached skills now follows both — the case that never worked before.

---

## Self-Review

**Spec coverage:** composition + caps + `recordSkillRun` fan-out → Task 1; attach-time rejection → Task 2; `alwaysAsk` → Task 3; internal route with permissions, quota, idempotency, install → Task 4; worker attach with version/`ON CONFLICT` → Task 5; tool with validation, PII, session guard, terminal declines, next-message copy → Task 6; migration-risk query and deploy order → Task 7. The spec's "known gaps" are documentation, not tasks. No gaps.

**Placeholders:** none. Three steps deliberately end in a lookup rather than a literal — the tool-registry file, `@serverless-saas/cache`'s client accessor, and `filterPII`'s field name — each with the exact command to resolve it and instructions to report what was found.

**Type consistency:** `fetchAgentSkills` / `recordSkillRuns` / `ComposedAgentSkills` are defined in Task 1 and used in Tasks 1 and 7. `MAX_ATTACHED_SKILLS` (8) and `MAX_COMPOSED_SKILL_CHARS` (24,000) match between Task 1 and Task 2. `attachToAgentId` is produced in Task 4 and consumed in Task 5. `{ alwaysAsk?: boolean }` is defined in Task 3 and called in Task 6. The internal route's request body in Task 4 matches the tool's `JSON.stringify` payload in Task 6 field for field.
