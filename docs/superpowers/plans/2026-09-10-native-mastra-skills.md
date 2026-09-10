# Native Mastra Skills (part 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `agent_skills`-composed-into-one-string mechanism with Mastra's native per-request `skills:` resolver, so a skill's content is never pasted into `instructions`, "Test in chat" tests exactly one skill with zero effect on the agent's real attached skills, and a hand-authored skill (no `install_id`) still works.

**Architecture:** `usage.ts` gains three new functions that return native Mastra `Skill` objects (via `createSkill()`) instead of a composed string. `platformAgent.ts` gets a new `skills:` resolver field that calls them. `chatStream.ts` stops composing skill content itself — it only sets `requestContext.get('testSkillInstallId')` when a test conversation, and keeps setting the persona prompt exactly as it does today.

**Tech Stack:** `@mastra/core` 1.64.0 (`createSkill` from `@mastra/core/skills`), `pg` (existing raw pool in `usage.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-mastra-native-runtime-migration-design.md` — this plan implements section "1. Skills" only. The other two sections (confirm-gate, Tasks workflow) are separate plans, independently shippable.

## Global Constraints

- A Mastra skill `name` must be 1-64 lowercase letters/numbers/hyphens (`InlineSkillInput`, `@mastra/core/skills` `types.d.ts`) — `createSkill()` throws otherwise. Source names (`agent_skills.name`, the catalog's display name) are free text and are never already in this shape.
- The agent-facing "when to use" description comes from `skill_versions.manifest->>'description'` (the frontmatter description enforced by the quality bar in `2026-09-08-skill-quality-bar-design.md`) — never `skills.description`, which is a separate, cosmetic dashboard subtitle.
- `agent_skills.install_id` is nullable (hand-authored skills, created via the in-chat path with no catalog install — see `agent-skills.ts` POST schema: `systemPrompt` required when `installId` is omitted). Both cases must keep working.
- The `default` row (every agent's onboarding-bootstrap persona prompt, `apps/api/src/routes/onboarding.ts`) is never a skill and must never appear in skills output — it's read separately by the existing `fetchAgentPersonaPrompt`, unchanged by this plan.
- Every DB query in `usage.ts` filters by both `agent_id`/`install_id` AND `tenant_id` — `agent_skills` and `skill_installs` carry `tenant_id` as an independent foreign key, so a mismatched pairing is representable and must not compose into the wrong tenant's prompt.

---

## Task 1: Replace `fetchAgentSkills`/`fetchTestSkillPrompt` with native-Skill-returning functions

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts`
- Test: `apps/agent-orchestrator/src/usage.test.ts`

**Interfaces:**
- Consumes: `getPool()` (existing, `usage.ts`), `recordSkillRuns(installIds: string[], tenantId: string): Promise<void>` (existing, unchanged).
- Produces (for Task 2):
  - `export function toMastraSkillName(raw: string): string`
  - `export async function fetchTestSkill(installId: string, tenantId: string): Promise<InlineSkill | null>`
  - `export async function fetchAttachedSkills(agentId: string, tenantId: string): Promise<InlineSkill[]>`
  - `InlineSkill` imported from `@mastra/core/skills` — has `.name`, `.description`, `.instructions` string properties.

- [ ] **Step 1: Write the failing tests**

Open `apps/agent-orchestrator/src/usage.test.ts`. Replace the import on line 9:

```typescript
import { fetchToolGovernance, fetchAgentModelSelection, fetchAgentPersonality, fetchAgentMemory, fetchAttachedSkills, fetchTestSkill, toMastraSkillName, agentBelongsToTenant, recordSkillRuns } from './usage.js'
```

Delete the entire `describe('fetchAgentSkills', ...)` block (currently lines 119-248 — everything from `describe('fetchAgentSkills', () => {` up to and including its closing `})`, right before `describe('agentBelongsToTenant', ...)`). Replace it with:

```typescript
describe('toMastraSkillName', () => {
  it('lowercases and hyphenates', () => {
    expect(toMastraSkillName('UGC Ad Production')).toBe('ugc-ad-production')
  })

  it('strips leading/trailing hyphens produced by punctuation', () => {
    expect(toMastraSkillName('  Bid Writer!!  ')).toBe('bid-writer')
  })

  it('falls back to "skill" when nothing alphanumeric survives', () => {
    expect(toMastraSkillName('###')).toBe('skill')
  })

  it('truncates to 64 characters, Mastra\'s InlineSkillInput.name limit', () => {
    const long = 'a'.repeat(100)
    expect(toMastraSkillName(long)).toHaveLength(64)
  })
})

describe('fetchTestSkill', () => {
  it('resolves the pinned version into a valid Mastra Skill', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', description: 'Use when writing bids.', body: 'Open with the client name.' },
    ] })

    const skill = await fetchTestSkill('install-1', 'tenant-1')

    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('bid-writer')
    expect(skill!.description).toBe('Use when writing bids.')
    expect(skill!.instructions).toBe('Open with the client name.')
  })

  it('scopes the query to the tenant, not just the install id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchTestSkill('install-1', 'tenant-1')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('si.tenant_id = $2')
    expect(params).toEqual(['install-1', 'tenant-1'])
  })

  it('returns null for a revoked or foreign install id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skill = await fetchTestSkill('install-1', 'attacker-tenant')
    expect(skill).toBeNull()
  })

  it('returns null when the body is empty', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'empty', description: 'Use when empty.', body: '   ' }] })
    const skill = await fetchTestSkill('install-1', 'tenant-1')
    expect(skill).toBeNull()
  })

  it('synthesizes a description when the manifest has none', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'legacy-skill', description: null, body: 'Do the thing.' }] })
    const skill = await fetchTestSkill('install-1', 'tenant-1')
    expect(skill!.description).toContain('legacy-skill')
  })

  it('records a run for the resolved install', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'bid-writer', description: 'Use when writing bids.', body: 'Body.' }] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // the recordSkillRuns UPDATE
    await fetchTestSkill('install-1', 'tenant-1')
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the fire-and-forget settle
    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    expect(mockPoolQuery.mock.calls[1][0]).toContain('UPDATE skill_installs')
  })
})

describe('fetchAttachedSkills', () => {
  it('returns a Mastra Skill for an installed row, resolved fresh', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', system_prompt: null, install_id: 'install-1', version: 1 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', description: 'Use when writing bids.', body: 'Open with the client name.' },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('bid-writer')
    expect(skills[0].instructions).toBe('Open with the client name.')
  })

  it('excludes the default persona row in the query itself', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAttachedSkills('agent-1', 'tenant-1')
    const sql = mockPoolQuery.mock.calls[0][0] as string
    expect(sql).toContain("name != 'default'")
  })

  it('scopes the query to the tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAttachedSkills('agent-1', 'tenant-1')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('tenant_id = $2')
    expect(params).toEqual(['agent-1', 'tenant-1'])
  })

  it('dedupes by name, keeping the highest version, resolving only that one', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', system_prompt: null, install_id: 'install-1', version: 1 },
      { name: 'bid-writer', system_prompt: null, install_id: 'install-2', version: 2 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', description: 'Use when writing bids.', body: 'New body v2.' },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(mockPoolQuery.mock.calls[1][1]).toEqual(['install-2', 'tenant-1'])
  })

  it('uses the stored system_prompt directly for a hand-authored row (no install_id)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'internal-helper', system_prompt: 'Do the internal thing.', install_id: null, version: 1 },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('internal-helper')
    expect(skills[0].instructions).toBe('Do the internal thing.')
    // No install to resolve — only the one agent_skills query ran.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })

  it('skips a hand-authored row with an empty system_prompt', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'empty', system_prompt: '  ', install_id: null, version: 1 },
    ] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })

  it('skips an installed row whose content fails to resolve', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'stale', system_prompt: null, install_id: 'install-1', version: 1 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })

  it('returns an empty array when the agent has no active skills', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/usage.test.ts`
Expected: FAIL — `toMastraSkillName`, `fetchTestSkill`, `fetchAttachedSkills` are not exported from `./usage.js` yet.

- [ ] **Step 3: Implement**

Open `apps/agent-orchestrator/src/usage.ts`. Add to the top imports (after `import { getAgentTools } from '@serverless-saas/ai'` — check the actual first few lines if that import isn't present; add after the existing `import pg from 'pg'` / `import { makeAppPool } from './db.js'` block):

```typescript
import { createSkill } from '@mastra/core/skills'
import type { InlineSkill } from '@mastra/core/skills'
```

Delete this entire block (currently lines 39-133 — from the `MAX_ATTACHED_SKILLS`/`MAX_COMPOSED_SKILL_CHARS` comment down through the closing `}` of `fetchAgentSkills`):

```typescript
export const MAX_ATTACHED_SKILLS = 8
export const MAX_COMPOSED_SKILL_CHARS = 24_000

export interface ComposedAgentSkills {
  // ... (through the end of fetchAgentSkills)
```

Delete `fetchTestSkillPrompt` (currently lines 135-165, the block starting with its doc comment and ending at its closing `}`).

Keep `fetchAgentPersonaPrompt` exactly as it is (currently lines 167-189) — this plan does not touch it.

In the now-empty space where those two functions were, add:

```typescript
/**
 * Mastra requires a skill `name` of 1-64 lowercase letters/numbers/hyphens
 * (InlineSkillInput, @mastra/core/skills types.d.ts) — createSkill() throws
 * otherwise. agent_skills.name and the skills catalog's display name are
 * free text ("UGC Ad Production"), never guaranteed to already be in that
 * shape, so every name is slugified before it reaches createSkill().
 */
export function toMastraSkillName(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug || 'skill'
}

/**
 * Resolves an installed skill's current, pinned-version content — name,
 * agent-facing description, and body. The description comes from
 * skill_versions.manifest->>'description' (the frontmatter description the
 * quality bar enforces — see 2026-09-08-skill-quality-bar-design.md), never
 * skills.description, which is a separate cosmetic dashboard subtitle.
 * Shared by fetchTestSkill and fetchAttachedSkills so both read content the
 * same way. Mirrors resolveInstall/resolveInstalledSkillBody in the API
 * package's agent-skills.ts, via the orchestrator's raw pg pool since it has
 * no drizzle access. Tenant-scoped: a wrong-tenant or unready installId
 * resolves to null rather than leaking cross-tenant content.
 */
async function resolveInstalledSkillContent(installId: string, tenantId: string): Promise<{ name: string; description: string; body: string } | null> {
  const p = getPool()
  try {
    const res = await p.query<{ name: string; description: string | null; body: string | null }>(
      `SELECT s.name, sv.manifest->>'description' AS description, sv.manifest->>'body' AS body
       FROM skill_installs si
       JOIN skills s ON s.id = si.skill_id
       JOIN skill_versions sv ON sv.skill_id = si.skill_id AND sv.version = si.installed_version
       WHERE si.id = $1 AND si.tenant_id = $2 AND si.status = 'active' AND sv.status = 'ready'
       LIMIT 1`,
      [installId, tenantId],
    )
    const row = res.rows[0]
    const body = row?.body?.trim()
    if (!row || !body) return null
    return { name: row.name, description: row.description?.trim() || `Use when the task matches "${row.name}".`, body }
  } catch (err) {
    console.error('[usage] resolveInstalledSkillContent error:', (err as Error).message)
    return null
  }
}

/**
 * Resolves ONE skill for a Test-in-chat conversation — bypassing
 * agent_skills entirely. Testing a skill must never touch the agent's real,
 * permanent skillset (see fetchConversationTestSkillInstallId in
 * persistence.ts), so this never reads or writes that table. Records a run
 * immediately since this call IS the run — there is no later composition
 * step to attach it to.
 */
export async function fetchTestSkill(installId: string, tenantId: string): Promise<InlineSkill | null> {
  const content = await resolveInstalledSkillContent(installId, tenantId)
  if (!content) return null
  recordSkillRuns([installId], tenantId).catch((err) => console.warn('[usage] fetchTestSkill recordSkillRuns failed:', (err as Error).message))
  return createSkill({ name: toMastraSkillName(content.name), description: content.description, instructions: content.body })
}

/**
 * Every active skill attached to the agent (excluding "default" — the
 * onboarding bootstrap row holding the agent's base persona, not a real
 * skill; read separately by fetchAgentPersonaPrompt), as native Mastra Skill
 * objects for the agent's `skills:` resolver.
 *
 * `tenantId` is required and filtered on, not just passed for logging:
 * agent_skills carries agent_id and tenant_id as two independent foreign
 * keys, so a row whose agent belongs to another tenant is representable.
 * Querying by agent_id alone would hand that row to this tenant's agent.
 *
 * Two content sources, by row shape:
 * - install_id set (the normal case — dashboard/"/" picker attach): content
 *   is resolved fresh from the pinned skill_installs/skill_versions, same as
 *   fetchTestSkill — the row's own stored system_prompt is never read, so an
 *   installed skill always reflects its current pinned version.
 * - install_id null (hand-authored — the in-chat create_skill path can
 *   attach a skill with no catalog install, per agent-skills.ts's POST
 *   schema): there is no install to resolve, so the row's own name/
 *   system_prompt IS the content. No stored "when to use" description exists
 *   for this case, so one is synthesized from the name — a known limitation
 *   versus an installed skill's real frontmatter description.
 */
export async function fetchAttachedSkills(agentId: string, tenantId: string): Promise<InlineSkill[]> {
  const p = getPool()
  const res = await p.query<{ name: string; system_prompt: string | null; install_id: string | null; version: number }>(
    `SELECT name, system_prompt, install_id, version FROM agent_skills
     WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active' AND name != 'default'
     ORDER BY created_at ASC, id ASC`,
    [agentId, tenantId],
  )

  // agent_skills is unique on (agent_id, tenant_id, name, version), and the
  // attach route lets a caller re-attach the same skill name at a new
  // version without deactivating the old row — so two active rows can share
  // a name. Dedupe to the highest version per name. A Map preserves the
  // key's first-insertion position when its value is overwritten, so this
  // keeps attachment order.
  const byName = new Map<string, (typeof res.rows)[number]>()
  for (const row of res.rows) {
    const existing = byName.get(row.name)
    if (!existing || row.version > existing.version) byName.set(row.name, row)
  }

  const skills: InlineSkill[] = []
  const installIds: string[] = []
  for (const row of byName.values()) {
    if (row.install_id) {
      const content = await resolveInstalledSkillContent(row.install_id, tenantId)
      if (!content) continue
      skills.push(createSkill({ name: toMastraSkillName(content.name), description: content.description, instructions: content.body }))
      installIds.push(row.install_id)
    } else {
      const body = row.system_prompt?.trim()
      if (!body) continue
      skills.push(createSkill({
        name: toMastraSkillName(row.name),
        description: `Use when the task matches "${row.name}".`,
        instructions: body,
      }))
    }
  }

  if (installIds.length > 0) {
    recordSkillRuns(installIds, tenantId).catch((err) => console.warn('[usage] fetchAttachedSkills recordSkillRuns failed:', (err as Error).message))
  }

  return skills
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/usage.test.ts`
Expected: PASS — all `toMastraSkillName`/`fetchTestSkill`/`fetchAttachedSkills` tests green, all pre-existing tests in this file still green.

- [ ] **Step 5: Type-check the whole package**

Run: `cd apps/agent-orchestrator && npx tsc --noEmit`
Expected: no errors. (This will show errors in `chatStream.ts` and `platformAgent.ts` if you've reached this step before Tasks 2/3 — that's expected until they're done; this step is here to confirm `usage.ts` itself compiles clean in isolation. If unsure, run `npx tsc --noEmit 2>&1 | grep usage.ts` and confirm it's empty.)

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts
git commit -m "feat(skills): replace composed-string skill fetch with native Mastra Skill objects

fetchAgentSkills/fetchTestSkillPrompt concatenated skill bodies into one
string for manual injection into instructions. Replaced with
fetchAttachedSkills/fetchTestSkill, returning real Mastra InlineSkill
objects (createSkill()) for the agent's upcoming skills: resolver — no
composition, no char budget, content resolved fresh per call."
```

---

## Task 2: Wire `skills:` into `platformAgent.ts`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: `fetchAttachedSkills(agentId, tenantId): Promise<InlineSkill[]>`, `fetchTestSkill(installId, tenantId): Promise<InlineSkill | null>` (Task 1).
- Produces: the `platformAgent` Agent config gains a `skills:` field. No other file depends on its exact shape — Task 3 only needs to know that `requestContext.set('testSkillInstallId', ...)` is what feeds it.

This file has no dedicated unit test today — `instructions:` and `tools:`, the two existing per-request resolver fields on this same `Agent`, are both untested by a dedicated test file (verified via `find . -iname "*platformAgent*"` — only the source file exists). This task follows that same existing convention: verified by type-check plus a manual smoke test, not a new test file.

- [ ] **Step 1: Add the import**

Open `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`. In the import block near the top (after `import { getOlmoMemory } from '../memory.js'`), add:

```typescript
import { fetchAttachedSkills, fetchTestSkill } from '../../usage.js'
```

- [ ] **Step 2: Add the `skills:` field**

Find the `instructions:` field's closing (`return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT`, followed by `},`). Immediately after that `},`, before the `tools:` field, add:

```typescript
  skills: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    const tenantId = requestContext?.get('tenantId') as string | undefined
    const agentId = requestContext?.get('agentId') as string | undefined
    if (!tenantId || !agentId) return []

    // Set by chatStream.ts only for a Test-in-chat conversation (see
    // fetchConversationTestSkillInstallId) — composes just that one skill,
    // never the agent's other real attached skills.
    const testSkillInstallId = requestContext?.get('testSkillInstallId') as string | undefined
    if (testSkillInstallId) {
      const skill = await fetchTestSkill(testSkillInstallId, tenantId)
      return skill ? [skill] : []
    }

    return fetchAttachedSkills(agentId, tenantId)
  },
```

- [ ] **Step 3: Type-check**

Run: `cd apps/agent-orchestrator && npx tsc --noEmit 2>&1 | grep platformAgent.ts`
Expected: empty output (no errors in this file).

- [ ] **Step 4: Manual smoke test**

This can't run until Task 3 also lands (chatStream.ts needs to set `agentId`/`tenantId`/`testSkillInstallId` on `requestContext` for this resolver to see them — it already sets `agentId`/`tenantId` today, only `testSkillInstallId` is new in Task 3). Note this step as pending; re-run it after Task 3:

1. Start the orchestrator locally (`cd apps/agent-orchestrator && pnpm dev`).
2. Attach a real skill to a test agent via the dashboard's "/" picker or Install button.
3. Send a chat message on that agent's conversation.
4. Confirm in the orchestrator's logs (or by asking the agent "what skills do you have?") that the attached skill's content is available — e.g. ask a question the skill's instructions specifically cover and confirm the answer reflects it.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(skills): add native skills: resolver to platformAgent

Reads the agent's real attached skills (or, for a Test-in-chat conversation,
just the one skill under test) via fetchAttachedSkills/fetchTestSkill —
Mastra composes them via its own skill/skill_read/skill_search tools instead
of anything being pasted into instructions."
```

---

## Task 3: Simplify `chatStream.ts` — persona-only prompt, `testSkillInstallId` on requestContext

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`

**Interfaces:**
- Consumes: `fetchAgentPersonaPrompt` (existing, unchanged), `fetchConversationTestSkillInstallId` (existing, unchanged, `persistence.ts`).
- Produces: `requestContext` now carries `testSkillInstallId` when set — this is what Task 2's `skills:` resolver reads.

Like Task 2, `runChatStream` (the function this touches) has no existing unit test — `chatStream.test.ts` only tests two smaller exported helpers (`buildMastraMessage`, `attachmentFromCanvasToolResult`) and mocks `usage.js`/`persistence.js` entirely as `{}`. This task is verified by type-check and the same manual smoke test as Task 2 (which depends on this task to actually reach the resolver).

- [ ] **Step 1: Update the import**

Open `apps/agent-orchestrator/src/routes/chatStream.ts`. Change:

```typescript
import { fetchAgentSkills, fetchTestSkillPrompt, fetchAgentPersonaPrompt, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection, recordSkillRuns, recordUsage } from '../usage.js'
```

to:

```typescript
import { fetchAgentPersonaPrompt, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection, recordUsage } from '../usage.js'
```

(`fetchAgentSkills`/`fetchTestSkillPrompt` no longer exist after Task 1; `recordSkillRuns` is no longer called from this file — it's called from inside `fetchAttachedSkills`/`fetchTestSkill` in `usage.ts` now.)

- [ ] **Step 2: Replace the skill-composition block**

Find this block (added earlier this session, now being simplified):

```typescript
    // Test-in-chat conversations carry the tested skill's install id on their
    // own metadata rather than an agent_skills row (see startSkillTestChat in
    // the web app) — so this conversation composes just the agent's persona
    // plus that one skill, never the agent's other real attached skills.
    const testSkillInstallId = await fetchConversationTestSkillInstallId(idToken, conversationId)

    const [agentSkills, agentName, personaPersonality, agentModelSelection] = await Promise.all([
      testSkillInstallId
        ? Promise.all([fetchAgentPersonaPrompt(agentId, tenantId), fetchTestSkillPrompt(testSkillInstallId, tenantId)])
            .then(([persona, test]) => ({
              systemPrompt: [persona, test.systemPrompt].filter((s): s is string => !!s).join('\n\n') || null,
              installIds: test.systemPrompt ? [testSkillInstallId] : [],
              droppedNames: [],
            }))
        : fetchAgentSkills(agentId, tenantId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
    ])
    if (agentSkills.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkills.systemPrompt)
    }
    requestContext.set('agentName', agentName ?? '')
    // One run per composed install per chat message. Fire-and-forget: a counter
    // write must never break or delay the stream.
    if (agentSkills.installIds.length > 0) {
      recordSkillRuns(agentSkills.installIds, tenantId)
        .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRuns failed:`, (err as Error).message))
    }
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
```

Replace it with:

```typescript
    // Test-in-chat conversations carry the tested skill's install id on
    // their own metadata (see startSkillTestChat in the web app) rather
    // than an agent_skills row. Setting it on requestContext is the only
    // thing this route does with it — platformAgent.ts's skills: resolver
    // reads it and composes just that one skill instead of the agent's
    // real attached ones. The agent's persona (below) is unaffected either
    // way — it's a separate concern, read the same regardless of test mode.
    const testSkillInstallId = await fetchConversationTestSkillInstallId(idToken, conversationId)
    if (testSkillInstallId) requestContext.set('testSkillInstallId', testSkillInstallId)

    const [agentPersonaPrompt, agentName, personaPersonality, agentModelSelection] = await Promise.all([
      fetchAgentPersonaPrompt(agentId, tenantId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
    ])
    if (agentPersonaPrompt) {
      requestContext.set('agentSystemPrompt', agentPersonaPrompt)
    }
    requestContext.set('agentName', agentName ?? '')
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
```

- [ ] **Step 3: Type-check**

Run: `cd apps/agent-orchestrator && npx tsc --noEmit`
Expected: no errors anywhere in the package (this is the point where Task 1 + 2 + 3 together should compile clean — if Task 2's Step 3 grep was empty and this is now also empty, all three tasks are wired correctly).

- [ ] **Step 4: Run the full orchestrator test suite**

Run: `cd apps/agent-orchestrator && npx vitest run`
Expected: PASS — `usage.test.ts` (Task 1's new tests), `chatStream.test.ts` (unaffected — its two tested functions don't touch this code path), and everything else in the suite.

- [ ] **Step 5: Manual smoke test (completes Task 2's Step 4)**

Run through both scenarios:

1. **Real attach:** attach a skill to a test agent (dashboard "/" picker or Install), send a chat message, confirm the skill's content is reflected in a response (ask something only that skill's instructions would answer correctly).
2. **Test-in-chat:** from the Skills page, click "Test in chat" on a skill. Confirm: (a) the new conversation reflects only that skill's behavior, not any other skill previously attached to the same agent; (b) the agent still sounds like itself (persona intact — ask an identity question, confirm it answers in character, not generically).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(skills): stop composing skills in chatStream, hand off to native resolver

chatStream.ts no longer resolves or composes any skill content itself — it
only sets testSkillInstallId on requestContext when present. Persona prompt
(agentSystemPrompt) is now unconditionally just the agent's own persona,
never mixed with skill text, matching the structural instructions/skills
split in the spec."
```

---

## Self-Review

**Spec coverage:** This plan implements spec section "1. Skills" in full — the `instructions:`/`skills:` split, `testSkillInstallId` requestContext flow, `agent_skills.system_prompt` no longer read for installed rows (Task 1's `resolveInstalledSkillContent`), and (a correction beyond what the spec's decision table stated) hand-authored rows' `system_prompt` *is* still read, since there is no install to resolve fresh content from — the spec's "stops being read" line only holds for installed rows. `MAX_ATTACHED_SKILLS`/`MAX_COMPOSED_SKILL_CHARS` are deleted in Task 1, per the spec's decision (the open question about a re-added attach-time count cap is a product decision belonging to a separate, later change, not this plan).

**Placeholder scan:** No TBD/TODO; every step has real, complete code.

**Type consistency:** `InlineSkill` (Task 1's return type) is the type Task 2's `skills:` resolver consumes and returns as `SkillInput[]` (an `InlineSkill[]` satisfies that). `toMastraSkillName`/`fetchTestSkill`/`fetchAttachedSkills` names and signatures match exactly between Task 1 (where they're defined) and Task 2 (where they're imported and called).
