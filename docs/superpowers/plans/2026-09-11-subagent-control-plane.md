# Sub-agent Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Olmo delegation a declared step budget, a spend check that can refuse it, its own identity instead of Olmo's, a structural depth limit, and a row recording what it cost.

**Architecture:** One `SubAgentSpec` per delegate, registered through a validating `defineSubAgent()` factory. A pure synchronous resolver turns the spec list plus request context into the `Record<string, Agent>` Mastra asks for, so depth, ownership and entitlement are expressed as absence from the map rather than as a rule a model could ignore. Delegation hooks passed at the two `stream()` call sites rewrite the sub-agent's identity, stamp depth, apply the spec's step budget, gate on credits, and write one link row per delegation.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@mastra/core@1.64.0`, vitest 4, raw `pg` pool via `getPool()`, drizzle-kit for the migration.

**Spec:** `docs/superpowers/specs/2026-09-10-subagent-control-plane-design.md`

## Global Constraints

- `@mastra/core@1.64.0` exactly — every API used here was verified against the installed copy, not recalled.
- Delegation hooks are a **per-execution** option (`AgentExecutionOptionsBase.delegation`, `agent.types.d.ts:671`), not an `Agent` constructor field. They must be passed at every call site that streams Olmo, or they do not run.
- Two such call sites exist and both must be wired: `apps/agent-orchestrator/src/routes/chatStream.ts:310` (SSE) and `apps/agent-orchestrator/src/index.ts:218` (WebSocket). A change landing on only one repeats the allow-mode split.
- `hookErrorStrategy: 'throw'` everywhere. The default (`'warn'`) continues the delegation when a hook throws, which for a credit hook means work done and nobody billed.
- ESM: every relative import ends in `.js`, including from `.ts` sources.
- Tests are vitest and must run with no database and no model call. Run: `pnpm --filter agent-orchestrator test`.
- Credit amounts are micro-credits (`bigint`), matching `checkCreditBalance`'s `balanceMicro`. `SubAgentSpec.estimatedCredits` is a plain `number` of micro-credits, converted at the comparison.
- Never widen `resolveDelegates` to async. Per-request facts are loaded into `RequestContext` upstream — the pattern `fetchAgentName()` / `fetchAgentContext()` already use.
- Commit each task separately. Commit by explicit path: this checkout is shared and usually carries unrelated uncommitted work.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Dependency status (checked 2026-09-11)

The native runtime migration this spec waited on has landed on `main`, and the
part that mattered most landed the right way: `requireApproval` now sits on
`generateImage.ts:31`, `generateVideo.ts:31` and `generateSong.ts:29` — on the
tools, not only on the chat stream. That is what makes a generation-heavy
delegate possible at all, because a tool-level rule survives the delegation
boundary and escalates upward, while the old hand-rolled `confirmGeneration`
Map would have left a delegate blocking on a Map nobody was watching.

Nothing in this plan re-touches approvals.

---

## File Structure

**New, all under `apps/agent-orchestrator/src/mastra/subagents/`:**

| File | Responsibility |
|---|---|
| `spec.ts` | The `SubAgentSpec` type, `defineSubAgent()` validation, `SubAgentSpecError` |
| `sources.ts` | The code source: the four existing delegates as specs, plus the registry accessors (`listSpecs`, `getSpec`, `maxDepthForHost`, `hostAllows`, `assertRegistryValid`) |
| `resolve.ts` | `resolveDelegates()` — specs plus context to a delegate map |
| `budget.ts` | The credit gate: remaining balance against a spec's `estimatedCredits` |
| `link.ts` | `recordDelegation()` — one narrow row per delegation |
| `hooks.ts` | `buildDelegationConfig()` — the two hooks plus `hookErrorStrategy` |
| `stub.ts` | The throwaway smoke-consumer delegate (deleted when the marketing vertical lands) |

**Modified:**

| File | Change |
|---|---|
| `src/mastra/agents/olmoDelegates.ts` | Shrinks to a call into `resolve.ts` |
| `src/mastra/context.ts` | Gains `delegationDepth`, `allowedSubAgents` |
| `src/mastra/index.ts` | Gains `backgroundTasks` |
| `src/routes/chatStream.ts` | Passes `delegation` and `maxSteps` to `stream()` |
| `src/index.ts` | Same, on the WebSocket path |
| `products/agent-platform/packages/schema/agents.ts` | `agent_delegations` table; `agent_templates.tenantId` |

`platformAgent.ts:435` keeps `agents: buildOlmoDelegates` unchanged — the signature is already correct.

---

## Task 1: The spec contract and its validation

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/spec.ts`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface SubAgentSpec`, `function defineSubAgent(input: SubAgentSpecInput): SubAgentSpec`, `class SubAgentSpecError extends Error`, `const NEGATIVE_CLAUSE = /\b(not for|don'?t use|do not use|never use|avoid)\b/i`.

Validation runs at module load, so a malformed delegate crashes the process at boot rather than mid-delegation.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/spec.test.ts
import { describe, it, expect } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { defineSubAgent, SubAgentSpecError } from '../spec.js'

const fakeAgent = {} as Agent
const base = {
  id: 'director',
  build: () => fakeAgent,
  description: 'Generates and edits images from a text description. Not for video or copywriting.',
  tags: ['image'],
  maxSteps: 8,
  estimatedCredits: 1_000,
}

describe('defineSubAgent', () => {
  it('returns the spec with maxDepth defaulted to 0', () => {
    const spec = defineSubAgent(base)
    expect(spec.maxDepth).toBe(0)
    expect(spec.id).toBe('director')
  })

  it('rejects a description with no negative clause', () => {
    expect(() => defineSubAgent({ ...base, description: 'Generates images.' }))
      .toThrow(SubAgentSpecError)
  })

  it('accepts any of the negative-clause phrasings', () => {
    for (const tail of ['Not for video.', "Don't use for copy.", 'Never use for audio.', 'Avoid for long video.']) {
      expect(() => defineSubAgent({ ...base, description: `Makes images. ${tail}` })).not.toThrow()
    }
  })

  it('rejects maxSteps below 1', () => {
    expect(() => defineSubAgent({ ...base, maxSteps: 0 })).toThrow(/maxSteps/)
  })

  it('rejects negative estimatedCredits', () => {
    expect(() => defineSubAgent({ ...base, estimatedCredits: -1 })).toThrow(/estimatedCredits/)
  })

  it('rejects negative maxDepth', () => {
    expect(() => defineSubAgent({ ...base, maxDepth: -1 })).toThrow(/maxDepth/)
  })

  it('rejects a blank id', () => {
    expect(() => defineSubAgent({ ...base, id: '  ' })).toThrow(/id/)
  })

  it('names the offending spec in the error message', () => {
    expect(() => defineSubAgent({ ...base, description: 'Generates images.' })).toThrow(/director/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test spec.test`
Expected: FAIL — cannot resolve `../spec.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/spec.ts
import type { Agent } from '@mastra/core/agent'

/**
 * One delegate, described independently of how it was built.
 *
 * `build: () => Agent` is the hinge that makes a database-backed registry a
 * later source swap rather than a rewrite: the code source returns the
 * existing module constant, a row source would construct an Agent from a row,
 * and resolve.ts never learns which it got.
 *
 * Deliberately absent: `tools` and `model` (the delegates own theirs; a second
 * copy here would be a second source of truth with nothing keeping the two in
 * sync), and any routing `priority` (ordering a delegate map does nothing —
 * the model routes on descriptions).
 */
export interface SubAgentSpec {
  id: string
  build: () => Agent
  description: string
  tags: string[]
  /** Replaces Mastra's silent stepCountIs(5) default for this delegate. */
  maxSteps: number
  /** Micro-credits, matching checkCreditBalance's balanceMicro units. */
  estimatedCredits: number
  /** How deep THIS agent may delegate. 0 = cannot delegate. */
  maxDepth: number
  requiresEntitlement?: string
  background?: { enabled: true; timeoutMs: number }
  /** A single spec id, or none. No chains — see the spec's non-goals. */
  fallback?: string
}

export type SubAgentSpecInput = Omit<SubAgentSpec, 'maxDepth'> & { maxDepth?: number }

export class SubAgentSpecError extends Error {
  constructor(specId: string, problem: string) {
    super(`sub-agent spec "${specId}": ${problem}`)
    this.name = 'SubAgentSpecError'
  }
}

/**
 * The description is the entire routing signal Olmo has. A description with no
 * "not for" clause is the single largest cause of misrouting, and a misroute
 * costs a whole sub-agent run — so the floor is enforced, not documented. Same
 * mechanism skillManifest.ts uses for skill descriptions.
 */
export const NEGATIVE_CLAUSE = /\b(not for|don'?t use|do not use|never use|avoid)\b/i

export function defineSubAgent(input: SubAgentSpecInput): SubAgentSpec {
  const id = input.id?.trim() ?? ''
  if (!id) throw new SubAgentSpecError(String(input.id), 'id must be a non-empty string')
  if (!NEGATIVE_CLAUSE.test(input.description ?? '')) {
    throw new SubAgentSpecError(id, 'description must say what this delegate is NOT for (e.g. "Not for video.")')
  }
  if (!Number.isFinite(input.maxSteps) || input.maxSteps < 1) {
    throw new SubAgentSpecError(id, `maxSteps must be >= 1, got ${input.maxSteps}`)
  }
  if (!Number.isFinite(input.estimatedCredits) || input.estimatedCredits < 0) {
    throw new SubAgentSpecError(id, `estimatedCredits must be >= 0, got ${input.estimatedCredits}`)
  }
  const maxDepth = input.maxDepth ?? 0
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new SubAgentSpecError(id, `maxDepth must be an integer >= 0, got ${maxDepth}`)
  }
  if (typeof input.build !== 'function') {
    throw new SubAgentSpecError(id, 'build must be a function returning an Agent')
  }
  return { ...input, id, maxDepth }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test spec.test`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/spec.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/spec.test.ts
git commit -m "feat(subagents): add SubAgentSpec and validating defineSubAgent factory

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The code source and registry accessors

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/sources.ts`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.test.ts`

**Interfaces:**
- Consumes: `defineSubAgent`, `SubAgentSpec`, `SubAgentSpecError` from `./spec.js`.
- Produces: `listSpecs(): SubAgentSpec[]`, `getSpec(id: string): SubAgentSpec | undefined`, `maxDepthForHost(agentName: string): number`, `hostAllows(agentName: string, spec: SubAgentSpec): boolean`, `assertRegistryValid(specs: SubAgentSpec[]): void`, `OLMO_HOST_MAX_DEPTH`.

The four descriptions below must be written to discriminate. The existing `DIRECTOR_DESCRIPTION` ("Generates and edits images from a text description.") has no negative clause and would fail validation — that is the point, and the new text belongs here rather than in the agent files, which keep their own `description` for Studio.

`estimatedCredits` values are the per-delegation *estimate*, not a reservation: a delegate that overruns is caught on the next delegation, not this one. That limitation is accepted in the spec; do not build a reservation system here.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.test.ts
import { describe, it, expect } from 'vitest'
import { listSpecs, getSpec, maxDepthForHost, hostAllows, assertRegistryValid, OLMO_HOST_MAX_DEPTH } from '../sources.js'
import { NEGATIVE_CLAUSE } from '../spec.js'

describe('code spec source', () => {
  it('registers the four existing delegates', () => {
    expect(listSpecs().map(s => s.id).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('gives every spec a description with a negative clause', () => {
    for (const spec of listSpecs()) expect(NEGATIVE_CLAUSE.test(spec.description)).toBe(true)
  })

  it('gives every spec a step budget that is not Mastra default of 5', () => {
    for (const spec of listSpecs()) expect(spec.maxSteps).toBeGreaterThanOrEqual(1)
  })

  it('leaves every code delegate unable to re-delegate', () => {
    for (const spec of listSpecs()) expect(spec.maxDepth).toBe(0)
  })

  it('resolves a spec by id and returns undefined for an unknown one', () => {
    expect(getSpec('director')?.id).toBe('director')
    expect(getSpec('nope')).toBeUndefined()
  })

  it('gives the olmo host a depth of 1 and every other host 0', () => {
    expect(maxDepthForHost('olmo')).toBe(OLMO_HOST_MAX_DEPTH)
    expect(maxDepthForHost('research engineer')).toBe(0)
    expect(maxDepthForHost('')).toBe(0)
  })

  it('allows every registered spec for the olmo host only', () => {
    const director = getSpec('director')!
    expect(hostAllows('olmo', director)).toBe(true)
    expect(hostAllows('director', director)).toBe(false)
  })

  it('rejects a fallback pointing at itself', () => {
    const self = { ...getSpec('pm')!, fallback: 'pm' }
    expect(() => assertRegistryValid([self])).toThrow(/itself/)
  })

  it('rejects a fallback pointing at an unregistered id', () => {
    const dangling = { ...getSpec('pm')!, fallback: 'ghost' }
    expect(() => assertRegistryValid([dangling])).toThrow(/ghost/)
  })

  it('rejects duplicate ids', () => {
    const pm = getSpec('pm')!
    expect(() => assertRegistryValid([pm, pm])).toThrow(/duplicate/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test sources.test`
Expected: FAIL — cannot resolve `../sources.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/sources.ts
import { defineSubAgent, SubAgentSpecError, type SubAgentSpec } from './spec.js'
import { pmAgentDelegate } from '../agents/pmAgent.js'
import { architectAgentDelegate } from '../agents/architectAgent.js'
import { directorAgentDelegate } from '../agents/directorAgent.js'
import { producerAgentDelegate } from '../agents/producerAgent.js'
import type { Agent } from '@mastra/core/agent'

/**
 * Olmo is the root and may delegate one level. Raising this is the whole
 * two-level rule, so it lives here as one named constant rather than being
 * spread across specs.
 */
export const OLMO_HOST_MAX_DEPTH = 1

/** The host row that may delegate at all. Lowercased comparison. */
const OLMO_HOST = 'olmo'

const SPECS: SubAgentSpec[] = [
  defineSubAgent({
    id: 'pm',
    build: () => pmAgentDelegate as unknown as Agent,
    description: 'Breaks a product ask into a PRD, roadmap and tasks. Not for generating images, video or audio, and not for writing code.',
    tags: ['product', 'planning'],
    maxSteps: 12,
    estimatedCredits: 2_000,
  }),
  defineSubAgent({
    id: 'architect',
    build: () => architectAgentDelegate as unknown as Agent,
    description: 'Designs technical approaches and reviews system structure. Not for generating media, and not for product prioritisation.',
    tags: ['engineering'],
    maxSteps: 12,
    estimatedCredits: 2_000,
  }),
  defineSubAgent({
    id: 'director',
    build: () => directorAgentDelegate as unknown as Agent,
    description: 'Generates and edits images, and generates short video clips, from a text description. Not for music or speech, and not for written copy.',
    tags: ['image', 'video'],
    maxSteps: 8,
    estimatedCredits: 20_000,
  }),
  defineSubAgent({
    id: 'producer',
    build: () => producerAgentDelegate as unknown as Agent,
    description: 'Generates music and audio from a description. Not for images or video, and not for written copy.',
    tags: ['audio'],
    maxSteps: 8,
    estimatedCredits: 20_000,
  }),
]

/**
 * Cross-spec checks that cannot run inside defineSubAgent, because they need
 * every spec registered first. Called at module load below, so a bad registry
 * fails at boot.
 */
export function assertRegistryValid(specs: SubAgentSpec[]): void {
  const ids = new Set<string>()
  for (const spec of specs) {
    if (ids.has(spec.id)) throw new SubAgentSpecError(spec.id, 'duplicate spec id')
    ids.add(spec.id)
  }
  for (const spec of specs) {
    if (!spec.fallback) continue
    if (spec.fallback === spec.id) throw new SubAgentSpecError(spec.id, 'fallback points at itself')
    if (!ids.has(spec.fallback)) throw new SubAgentSpecError(spec.id, `fallback "${spec.fallback}" is not a registered spec`)
  }
}

assertRegistryValid(SPECS)

export function listSpecs(): SubAgentSpec[] {
  return SPECS
}

export function getSpec(id: string): SubAgentSpec | undefined {
  return SPECS.find(s => s.id === id)
}

/**
 * Depth is read from the HOST's spec, not the delegate's: maxDepth says how
 * deep that agent may delegate. A specialist with maxDepth 0 therefore
 * receives an empty delegate map and has nothing to call.
 */
export function maxDepthForHost(agentName: string): number {
  const name = agentName.toLowerCase().trim()
  if (name === OLMO_HOST) return OLMO_HOST_MAX_DEPTH
  return getSpec(name)?.maxDepth ?? 0
}

/**
 * Which host may see which spec. Today: Olmo sees all of them and nobody else
 * sees any — the gate that stops every custom agent row falling through
 * platformAgent and inheriting Olmo's delegates.
 */
export function hostAllows(agentName: string, _spec: SubAgentSpec): boolean {
  return agentName.toLowerCase().trim() === OLMO_HOST
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test sources.test`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/sources.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.test.ts
git commit -m "feat(subagents): register the four code delegates as specs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The resolver, and the context fields it reads

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/resolve.ts`
- Modify: `apps/agent-orchestrator/src/mastra/context.ts` (add two fields to `tenantContextSchema`)
- Modify: `apps/agent-orchestrator/src/mastra/agents/olmoDelegates.ts` (delegate to `resolve.ts`)
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/resolve.test.ts`
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/olmoDelegates.test.ts` (existing — extend, do not replace)

**Interfaces:**
- Consumes: `listSpecs`, `maxDepthForHost`, `hostAllows` from `./sources.js`; `TenantContext` from `../context.js`.
- Produces: `resolveDelegates({ requestContext }: { requestContext?: RequestContext<TenantContext> }): Record<string, Agent>`.

The existing `olmoDelegates.test.ts` pins the current contract and is the safety net for this refactor: the exact-map assertion changes shape, but every behaviour it pins must still hold — four delegates for "Olmo", case-insensitive, empty for another row, empty when unset, empty when the context itself is undefined.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/resolve.test.ts
import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { resolveDelegates } from '../resolve.js'

function ctx(entries: Partial<TenantContext>): RequestContext<TenantContext> {
  const rc = new RequestContext<TenantContext>()
  for (const [k, v] of Object.entries(entries)) rc.set(k as keyof TenantContext, v as never)
  return rc
}

describe('resolveDelegates', () => {
  it('returns every spec for the olmo host at depth 0', () => {
    const delegates = resolveDelegates({ requestContext: ctx({ agentName: 'Olmo' }) })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('returns an empty map once depth has reached the host ceiling', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', delegationDepth: 1 }) })).toEqual({})
  })

  it('returns an empty map for a delegate host, which cannot re-delegate', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'director', delegationDepth: 1 }) })).toEqual({})
  })

  it('returns an empty map for an unrelated agent row', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'Research Engineer' }) })).toEqual({})
  })

  it('keeps ungated specs even when the allowed set is empty', () => {
    // No code spec sets requiresEntitlement today, so this asserts the filter
    // is inert rather than wrong: an allowed set that omits everything must
    // still return the ungated specs.
    const delegates = resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', allowedSubAgents: [] }) })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('fails open when the allowed set is unset', () => {
    expect(Object.keys(resolveDelegates({ requestContext: ctx({ agentName: 'Olmo' }) }))).toHaveLength(4)
  })

  it('returns an empty map when the context itself is undefined', () => {
    expect(resolveDelegates({ requestContext: undefined })).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test resolve.test`
Expected: FAIL — cannot resolve `../resolve.js`.

- [ ] **Step 3: Add the two context fields**

In `apps/agent-orchestrator/src/mastra/context.ts`, inside `tenantContextSchema`, after `sessionId`:

```ts
  // How many delegation boundaries this run is below the user-facing agent.
  // Stamped by onDelegationStart (subagents/hooks.ts) onto the outgoing
  // context; read by resolveDelegates to return {} at the host's ceiling.
  // Load-bearing, not advisory: Mastra copies the parent's context into the
  // sub-agent almost wholesale (agent-Dp3vcrIx.cjs:35119 excludes only four
  // internal keys), so a delegate inherits agentName='olmo' and would
  // otherwise resolve Olmo's own delegate map and re-delegate in a circle.
  delegationDepth: z.number().optional(),
  // The sub-agent ids this tenant may use. Filled upstream by an ownership
  // query today and by an install query when sharing ships — the resolver
  // does not change either way. Unset means "unconfigured": fail open.
  allowedSubAgents: z.array(z.string()).optional(),
```

- [ ] **Step 4: Write the resolver**

```ts
// apps/agent-orchestrator/src/mastra/subagents/resolve.ts
import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { listSpecs, maxDepthForHost, hostAllows } from './sources.js'

/**
 * Specs plus request context to the delegate map Mastra asks for.
 *
 * Synchronous and pure on purpose. Nothing here does IO: specs are
 * module-level and every per-request fact is loaded into RequestContext
 * upstream, the same way fetchAgentName()/fetchAgentContext() already work.
 * Making this async would put an await in front of every turn and make the
 * whole control plane untestable without a database.
 *
 * The structural claim: this never returns an Agent the caller is not allowed
 * to use. Depth, host and entitlement are all expressed as absence from the
 * map — there is no downstream check and no prompt telling Olmo what not to
 * call.
 */
export function resolveDelegates(
  { requestContext }: { requestContext?: RequestContext<TenantContext> },
): Record<string, Agent> {
  const ctx = requestContext
  const agentName = ((ctx?.get('agentName') as string | undefined) ?? '').toLowerCase().trim()
  const depth = (ctx?.get('delegationDepth') as number | undefined) ?? 0
  const allowed = ctx?.get('allowedSubAgents') as string[] | undefined

  if (depth >= maxDepthForHost(agentName)) return {}

  const specs = listSpecs()
    .filter(spec => hostAllows(agentName, spec))
    // An entitlement-gated spec is absent, not present-and-blocked. `allowed`
    // being undefined means the source is unconfigured — fail open, since a
    // silently missing capability looks to the user like Olmo doing the job
    // badly with no signal anything was hidden.
    .filter(spec => !allowed || !spec.requiresEntitlement || allowed.includes(spec.id))

  return Object.fromEntries(specs.map(spec => [spec.id, spec.build()]))
}
```

- [ ] **Step 5: Shrink `olmoDelegates.ts` to a call into the resolver**

Replace the whole body of `apps/agent-orchestrator/src/mastra/agents/olmoDelegates.ts` with:

```ts
import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { resolveDelegates } from '../subagents/resolve.js'

// platformAgent (Olmo) is resolveAgent's fallback for EVERY unmatched agent
// row — Research Engineer, Analyst, custom tenant agents, all of them. The
// gate that keeps delegation scoped to the seeded Olmo row now lives in
// subagents/sources.ts (hostAllows), alongside the depth ceiling and the
// entitlement filter. This function stays as the name platformAgent.ts:435
// binds to.
export function buildOlmoDelegates(
  args: { requestContext?: RequestContext<TenantContext> },
): Record<string, Agent> {
  return resolveDelegates(args)
}
```

- [ ] **Step 6: Extend the existing delegate test**

In `apps/agent-orchestrator/src/mastra/agents/__tests__/olmoDelegates.test.ts`, replace the first test's exact-map assertion (the delegate map is now keyed by spec id, and identity is asserted per key) and add a depth case:

```ts
  it('returns all four delegates when agentName is "olmo" (exact)', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Olmo')
    const delegates = buildOlmoDelegates({ requestContext })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
    expect(delegates.pm).toBe(pmAgentDelegate)
    expect(delegates.architect).toBe(architectAgentDelegate)
    expect(delegates.director).toBe(directorAgentDelegate)
    expect(delegates.producer).toBe(producerAgentDelegate)
  })

  it('returns no delegates once the depth ceiling is reached', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Olmo')
    requestContext.set('delegationDepth', 1)
    expect(buildOlmoDelegates({ requestContext })).toEqual({})
  })
```

Leave the other four tests untouched — they must still pass unchanged.

- [ ] **Step 7: Run the full orchestrator suite**

Run: `pnpm --filter agent-orchestrator test`
Expected: PASS. If anything outside `subagents/` or `olmoDelegates` fails, stop — the refactor has reached further than intended.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/resolve.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/resolve.test.ts \
        apps/agent-orchestrator/src/mastra/context.ts \
        apps/agent-orchestrator/src/mastra/agents/olmoDelegates.ts \
        apps/agent-orchestrator/src/mastra/agents/__tests__/olmoDelegates.test.ts
git commit -m "feat(subagents): resolve delegates from specs, enforce depth structurally

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The credit gate

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/budget.ts`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/budget.test.ts`

**Interfaces:**
- Consumes: `checkCreditBalance` from `../../credits.js`; `SubAgentSpec` from `./spec.js`.
- Produces: `interface BudgetDecision { allowed: boolean; reason?: string }`, `async function checkDelegationBudget(args: { tenantId: string; spec: SubAgentSpec }, deps?: { check?: typeof checkCreditBalance }): Promise<BudgetDecision>`.

Dependency injection matches `credits.ts`'s own pattern (`DebitChatTurnDeps`, `SettleTaskDeps`), so the test needs no pool.

Fails **closed**, like `checkCreditBalance` itself: a delegation is real spend, and a database error must not hand out paid capacity.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/budget.test.ts
import { describe, it, expect } from 'vitest'
import { checkDelegationBudget } from '../budget.js'
import { getSpec } from '../sources.js'

const director = getSpec('director')!   // estimatedCredits 20_000

describe('checkDelegationBudget', () => {
  it('allows when the balance covers the estimate', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 50_000n, unlimited: false })
    expect(await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).toEqual({ allowed: true })
  })

  it('allows an unlimited tenant without reading a balance', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 0n, unlimited: true })
    expect((await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).allowed).toBe(true)
  })

  it('refuses when the balance is below the estimate, with a reason naming the delegate', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 1_000n, unlimited: false })
    const decision = await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/director/)
    expect(decision.reason).toMatch(/credit/i)
  })

  it('refuses when the account is not allowed to spend at all', async () => {
    const check = async () => ({ allowed: false, balanceMicro: 0n, unlimited: false })
    expect((await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).allowed).toBe(false)
  })

  it('fails closed when the balance check throws', async () => {
    const check = async () => { throw new Error('pool down') }
    const decision = await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/could not be checked/i)
  })

  it('refuses when there is no tenant to bill', async () => {
    const check = async () => { throw new Error('should not be called') }
    expect((await checkDelegationBudget({ tenantId: '', spec: director }, { check })).allowed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test budget.test`
Expected: FAIL — cannot resolve `../budget.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/budget.ts
import { checkCreditBalance } from '../../credits.js'
import type { SubAgentSpec } from './spec.js'

export interface BudgetDecision {
  allowed: boolean
  /** Shown to the parent model as rejectionReason, so it can wrap up honestly. */
  reason?: string
}

export interface BudgetDeps {
  check?: typeof checkCreditBalance
}

/**
 * Per-delegation spend gate. Mastra's maxSteps and a goal's maxRuns count
 * STEPS — fifty steps of text and fifty steps of video generation look the
 * same to them — so money is checked here, separately, before the delegation
 * runs.
 *
 * The estimate is static (SubAgentSpec.estimatedCredits), so this is a
 * pre-check, not a reservation: a delegate that generates three videos when
 * its spec said one overruns and is caught on the NEXT delegation. Reserving
 * properly means charge-then-settle, which chargeTaskEstimate/settleTask
 * already do for tasks — an argument for routing expensive work through
 * tasks, not for a second reservation system here.
 *
 * Fails closed, matching checkCreditBalance.
 */
export async function checkDelegationBudget(
  args: { tenantId: string; spec: SubAgentSpec },
  deps: BudgetDeps = {},
): Promise<BudgetDecision> {
  const { tenantId, spec } = args
  if (!tenantId) {
    return { allowed: false, reason: `Delegation to "${spec.id}" refused: no tenant to bill.` }
  }
  const check = deps.check ?? checkCreditBalance
  try {
    const balance = await check(tenantId)
    if (balance.unlimited) return { allowed: true }
    if (!balance.allowed) {
      return { allowed: false, reason: `Delegation to "${spec.id}" refused: this workspace is out of credits.` }
    }
    if (balance.balanceMicro < BigInt(Math.ceil(spec.estimatedCredits))) {
      return {
        allowed: false,
        reason: `Delegation to "${spec.id}" refused: it needs about ${spec.estimatedCredits} micro-credits and the workspace has ${balance.balanceMicro}. Finish with what you already have, and tell the user credits ran out.`,
      }
    }
    return { allowed: true }
  } catch (err) {
    console.error(`[subagents] budget check failed tenantId=${tenantId} spec=${spec.id}:`, (err as Error).message)
    return { allowed: false, reason: `Delegation to "${spec.id}" refused: credits could not be checked.` }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test budget.test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/budget.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/budget.test.ts
git commit -m "feat(subagents): gate each delegation on remaining credits, failing closed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The delegation link row

**Files:**
- Modify: `products/agent-platform/packages/schema/agents.ts` (add `agentDelegations`)
- Create: `packages/foundation/database/migrations/00XX_*.sql` (generated, do not hand-write)
- Create: `apps/agent-orchestrator/src/mastra/subagents/link.ts`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/link.test.ts`

**Interfaces:**
- Consumes: `getPool` from `../../usage.js`.
- Produces: `interface DelegationRecord { tenantId: string; agentId: string | null; conversationId: string | null; primitiveId: string; runId: string; toolCallId: string; success: boolean; durationMs: number; rejectionReason?: string | null; errorMessage?: string | null }`, `async function recordDelegation(record: DelegationRecord, deps?: { pool?: { query: (text: string, values: unknown[]) => Promise<unknown> } }): Promise<void>`.

This is a **narrow link row, not a telemetry table**. Mastra's `Observability` + `DefaultExporter` is already registered and already records each delegation as a typed span with duration, tokens, model and errors, queryable through `mastra.getStorage()?.getStore('observability')`. What Mastra does not know is our tenant, our conversation and our credit ledger. Do not add token counts, model names or costs to this table — read those from the observability store, keyed by `run_id`.

- [ ] **Step 1: Add the table to the schema**

In `products/agent-platform/packages/schema/agents.ts`, after the `agentTemplates` block:

```ts
// One row per delegation attempt, success or failure. Deliberately narrow:
// Mastra's own observability store already holds duration, tokens, model and
// errors for the same delegation, keyed by run_id — this table exists only to
// join that span to OUR facts (tenant, conversation, refusal). Adding token or
// cost columns here rebuilds what Mastra already records.
export const agentDelegations = pgTable('agent_delegations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  // The host agent row that delegated (Olmo today). Nullable because a
  // delegation refused before the run starts may not have resolved one.
  agentId: uuid('agent_id').references(() => agents.id),
  conversationId: uuid('conversation_id'),
  // The spec id of the delegate — 'director', 'pm', … Text, not an FK: specs
  // are code constants today and rows later.
  primitiveId: text('primitive_id').notNull(),
  // Mastra run id — the join key into the observability store.
  runId: text('run_id').notNull(),
  toolCallId: text('tool_call_id').notNull(),
  success: boolean('success').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  // Set when the credit gate refused the delegation before it ran.
  rejectionReason: text('rejection_reason'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('agent_delegations_tenant_idx').on(table.tenantId, table.createdAt),
  runIdx: index('agent_delegations_run_idx').on(table.runId),
}))

export type AgentDelegation = typeof agentDelegations.$inferSelect
export type NewAgentDelegation = typeof agentDelegations.$inferInsert
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @serverless-saas/database db:generate`
Expected: a new `packages/foundation/database/migrations/00XX_<name>.sql` creating `agent_delegations` and its two indexes, plus an updated `meta/_journal.json`.

Read the generated SQL before continuing. If it contains any statement that is not `CREATE TABLE agent_delegations` / `CREATE INDEX` / its foreign keys, stop — drizzle has picked up unrelated schema drift, and that must not ride along in this commit.

- [ ] **Step 3: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/link.test.ts
import { describe, it, expect, vi } from 'vitest'
import { recordDelegation } from '../link.js'

const base = {
  tenantId: 't1', agentId: 'a1', conversationId: 'c1',
  primitiveId: 'director', runId: 'run-1', toolCallId: 'call-1',
  success: true, durationMs: 1234,
}

describe('recordDelegation', () => {
  it('inserts one row with the delegation facts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await recordDelegation(base, { pool: { query } })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toMatch(/insert into agent_delegations/i)
    expect(values).toEqual(['t1', 'a1', 'c1', 'director', 'run-1', 'call-1', true, 1234, null, null])
  })

  it('carries a rejection reason for a refused delegation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await recordDelegation({ ...base, success: false, rejectionReason: 'out of credits' }, { pool: { query } })
    expect(query.mock.calls[0][1][8]).toBe('out of credits')
  })

  it('never throws when the insert fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('pool down'))
    await expect(recordDelegation(base, { pool: { query } })).resolves.toBeUndefined()
  })

  it('skips the insert when there is no tenant', async () => {
    const query = vi.fn()
    await recordDelegation({ ...base, tenantId: '' }, { pool: { query } })
    expect(query).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test link.test`
Expected: FAIL — cannot resolve `../link.js`.

- [ ] **Step 5: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/link.ts
import { getPool } from '../../usage.js'

export interface DelegationRecord {
  tenantId: string
  agentId: string | null
  conversationId: string | null
  primitiveId: string
  runId: string
  toolCallId: string
  success: boolean
  durationMs: number
  rejectionReason?: string | null
  errorMessage?: string | null
}

interface QueryablePool { query: (text: string, values: unknown[]) => Promise<unknown> }

const INSERT = `
  insert into agent_delegations
    (tenant_id, agent_id, conversation_id, primitive_id, run_id, tool_call_id, success, duration_ms, rejection_reason, error_message)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`

/**
 * One row per delegation, success or failure. Swallows its own errors: this
 * runs inside onDelegationComplete under hookErrorStrategy 'throw', where a
 * throw fails the delegation itself. A lost audit row must not cost the user
 * work that already happened — so the failure is logged loudly and the
 * delegation stands.
 */
export async function recordDelegation(
  record: DelegationRecord,
  deps: { pool?: QueryablePool } = {},
): Promise<void> {
  if (!record.tenantId) return
  try {
    const pool = deps.pool ?? getPool()
    await pool.query(INSERT, [
      record.tenantId,
      record.agentId || null,
      record.conversationId || null,
      record.primitiveId,
      record.runId,
      record.toolCallId,
      record.success,
      record.durationMs,
      record.rejectionReason ?? null,
      record.errorMessage ?? null,
    ])
  } catch (err) {
    console.error(
      `[subagents] delegation link row lost tenantId=${record.tenantId} primitive=${record.primitiveId} runId=${record.runId}:`,
      (err as Error).message,
    )
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test link.test`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/schema/agents.ts \
        packages/foundation/database/migrations \
        apps/agent-orchestrator/src/mastra/subagents/link.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/link.test.ts
git commit -m "feat(subagents): record one narrow link row per delegation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The delegation hooks

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/hooks.ts`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/hooks.test.ts`

**Interfaces:**
- Consumes: `getSpec` from `./sources.js`; `checkDelegationBudget` from `./budget.js`; `recordDelegation` from `./link.js`; `DelegationConfig`, `DelegationStartContext`, `DelegationCompleteContext` types from `@mastra/core/agent`.
- Produces: `function buildDelegationConfig(deps?: HookDeps): DelegationConfig`, `interface HookDeps { budget?: typeof checkDelegationBudget; record?: typeof recordDelegation }`.

`onDelegationStart` runs in this order, and the order matters: refuse before spending, then rewrite identity, then stamp depth.

The identity rewrite is the fix for Finding 1 and is not optional. Mastra copies the parent's request context into the sub-agent excluding only four internal keys (`agent-Dp3vcrIx.cjs:35119`), so without this a delegate runs with Olmo's `agentId` (and therefore resolves **Olmo's** attached skills), Olmo's `agentSystemPrompt` layered on top of its own instructions, and `agentName: 'olmo'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { buildDelegationConfig } from '../hooks.js'

function startContext(overrides: Record<string, unknown> = {}) {
  const requestContext = new RequestContext<TenantContext>()
  requestContext.set('tenantId', 't1')
  requestContext.set('userId', 'u1')
  requestContext.set('sessionId', 'conv-1')
  requestContext.set('agentId', 'olmo-agent-id')
  requestContext.set('agentName', 'Olmo')
  requestContext.set('agentSystemPrompt', 'OLMO PROMPT OVERRIDE')
  requestContext.set('personaPersonality', 'olmo persona')
  return {
    primitiveId: 'director', primitiveType: 'agent' as const, prompt: 'make an image',
    params: {}, iteration: 1, runId: 'run-1', toolCallId: 'call-1',
    parentAgentId: 'olmo', parentAgentName: 'Olmo', messages: [],
    requestContext: requestContext as unknown as RequestContext,
    ...overrides,
  }
}

const allow = async () => ({ allowed: true })

describe('onDelegationStart', () => {
  it('applies the spec maxSteps instead of Mastra default of 5', async () => {
    const config = buildDelegationConfig({ budget: allow })
    const result = await config.onDelegationStart!(startContext() as never)
    expect(result).toMatchObject({ modifiedMaxSteps: 8 })
  })

  it('replaces the host identity with the delegate own', async () => {
    const ctx = startContext()
    await buildDelegationConfig({ budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('agentName')).toBe('director')
    expect(ctx.requestContext.get('agentId')).toBe('director')
    expect(ctx.requestContext.get('agentSystemPrompt')).toBe('')
    expect(ctx.requestContext.get('personaPersonality')).toBe('')
  })

  it('keeps the facts that are the tenant, not the agent', async () => {
    const ctx = startContext()
    await buildDelegationConfig({ budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('tenantId')).toBe('t1')
    expect(ctx.requestContext.get('userId')).toBe('u1')
    expect(ctx.requestContext.get('sessionId')).toBe('conv-1')
  })

  it('stamps the depth one deeper than the parent', async () => {
    const ctx = startContext()
    await buildDelegationConfig({ budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('delegationDepth')).toBe(1)
    const nested = startContext()
    nested.requestContext.set('delegationDepth', 1)
    await buildDelegationConfig({ budget: allow }).onDelegationStart!(nested as never)
    expect(nested.requestContext.get('delegationDepth')).toBe(2)
  })

  it('refuses the delegation when the budget gate says no, and does not rewrite identity', async () => {
    const ctx = startContext()
    const budget = async () => ({ allowed: false, reason: 'out of credits' })
    const result = await buildDelegationConfig({ budget }).onDelegationStart!(ctx as never)
    expect(result).toEqual({ proceed: false, rejectionReason: 'out of credits' })
    expect(ctx.requestContext.get('agentName')).toBe('Olmo')
  })

  it('records a refused delegation as a failed link row', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const budget = async () => ({ allowed: false, reason: 'out of credits' })
    await buildDelegationConfig({ budget, record }).onDelegationStart!(startContext() as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      primitiveId: 'director', success: false, rejectionReason: 'out of credits',
    }))
  })

  it('refuses a delegation to an unregistered primitive', async () => {
    const result = await buildDelegationConfig({ budget: allow })
      .onDelegationStart!(startContext({ primitiveId: 'ghost' }) as never)
    expect(result).toMatchObject({ proceed: false })
  })
})

function completeContext(overrides: Record<string, unknown> = {}) {
  const requestContext = new RequestContext<TenantContext>()
  requestContext.set('tenantId', 't1')
  requestContext.set('agentId', 'olmo-agent-id')
  requestContext.set('sessionId', 'conv-1')
  return {
    primitiveId: 'director', primitiveType: 'agent' as const, prompt: 'make an image',
    result: { text: 'here it is', finishReason: 'stop' as const },
    duration: 900, success: true, iteration: 1, runId: 'run-1', toolCallId: 'call-1',
    parentAgentId: 'olmo', parentAgentName: 'Olmo', messages: [], bail: vi.fn(),
    requestContext: requestContext as unknown as RequestContext,
    ...overrides,
  }
}

describe('onDelegationComplete', () => {
  it('writes one link row for a successful delegation', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    await buildDelegationConfig({ record }).onDelegationComplete!(completeContext() as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      primitiveId: 'director', success: true, durationMs: 900, runId: 'run-1',
    }))
  })

  it('writes a link row carrying the error for a failed delegation', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const ctx = completeContext({ success: false, error: new Error('model exploded') })
    await buildDelegationConfig({ record }).onDelegationComplete!(ctx as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: 'model exploded' }))
  })

  it('bails with feedback when a delegation fails and the spec has no fallback', async () => {
    const ctx = completeContext({ success: false, error: new Error('model exploded') })
    const result = await buildDelegationConfig({ record: async () => {} }).onDelegationComplete!(ctx as never)
    expect(ctx.bail).toHaveBeenCalled()
    expect(result?.feedback).toMatch(/director/)
  })

  it('replaces empty text after a tool-calls stop with an honest description', async () => {
    const ctx = completeContext({ result: { text: '', finishReason: 'tool-calls' } })
    const result = await buildDelegationConfig({ record: async () => {} }).onDelegationComplete!(ctx as never)
    expect(result?.resultText).toMatch(/did not finish/i)
    expect(ctx.bail).not.toHaveBeenCalled()
  })

  it('leaves a normal result untouched', async () => {
    const result = await buildDelegationConfig({ record: async () => {} }).onDelegationComplete!(completeContext() as never)
    expect(result?.resultText).toBeUndefined()
    expect(result?.feedback).toBeUndefined()
  })
})

describe('buildDelegationConfig', () => {
  it('fails the delegation when a hook throws, rather than continuing quietly', () => {
    expect(buildDelegationConfig().hookErrorStrategy).toBe('throw')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test hooks.test`
Expected: FAIL — cannot resolve `../hooks.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/hooks.ts
import type {
  DelegationConfig, DelegationCompleteContext, DelegationStartContext,
} from '@mastra/core/agent'
import { getSpec } from './sources.js'
import { checkDelegationBudget } from './budget.js'
import { recordDelegation } from './link.js'

export interface HookDeps {
  budget?: typeof checkDelegationBudget
  record?: typeof recordDelegation
}

/**
 * The delegation lifecycle for the Olmo path.
 *
 * NOTE: `delegation` is a per-EXECUTION option, not an Agent constructor
 * field, so this config has to be passed at every stream() call site that can
 * reach Olmo. There are two — routes/chatStream.ts (SSE) and index.ts
 * (WebSocket) — and a hook wired into only one of them silently does not run
 * on the other path.
 */
export function buildDelegationConfig(deps: HookDeps = {}): DelegationConfig {
  const budget = deps.budget ?? checkDelegationBudget
  const record = deps.record ?? recordDelegation

  return {
    // If a hook throws, fail the delegation. The default ('warn') proceeds
    // with the original prompt and result — which for a credit hook means
    // work done and nobody billed, silently. Hook throws are also recorded on
    // the run context under __mastra_delegationHookErrors.
    hookErrorStrategy: 'throw',

    onDelegationStart: async (context: DelegationStartContext) => {
      const ctx = context.requestContext
      const spec = getSpec(context.primitiveId)
      const tenantId = (ctx.get('tenantId') as string | undefined) ?? ''

      if (!spec) {
        // resolveDelegates cannot return an unregistered delegate, so this is
        // a registry bug rather than a routing one — refuse loudly.
        return { proceed: false, rejectionReason: `"${context.primitiveId}" is not a registered sub-agent.` }
      }

      // 1. Money first: refuse before anything is spent.
      const decision = await budget({ tenantId, spec })
      if (!decision.allowed) {
        await record({
          tenantId,
          agentId: (ctx.get('agentId') as string | undefined) ?? null,
          conversationId: (ctx.get('sessionId') as string | undefined) ?? null,
          primitiveId: spec.id,
          runId: context.runId,
          toolCallId: context.toolCallId,
          success: false,
          durationMs: 0,
          rejectionReason: decision.reason ?? 'refused',
        })
        return { proceed: false, rejectionReason: decision.reason }
      }

      // 2. Identity. Mastra hands the sub-agent a near-complete copy of the
      // parent's context (agent-Dp3vcrIx.cjs:35119 excludes only four internal
      // keys), so without this the delegate runs as Olmo: Olmo's agentId — and
      // therefore Olmo's attached skills — and Olmo's prompt override layered
      // on top of its own instructions. Only the tenant-level facts survive.
      ctx.set('agentId', spec.id)
      ctx.set('agentName', spec.id)
      ctx.set('agentSystemPrompt', '')
      ctx.set('personaPersonality', '')

      // 3. Depth. The only thing standing between the system and a delegation
      // loop, because the agentName gate's own input is inherited.
      const depth = (ctx.get('delegationDepth') as number | undefined) ?? 0
      ctx.set('delegationDepth', depth + 1)

      // 4. The step budget this delegate declared, replacing stepCountIs(5).
      return { modifiedMaxSteps: spec.maxSteps }
    },

    onDelegationComplete: async (context: DelegationCompleteContext) => {
      const ctx = context.requestContext as unknown as { get: (k: string) => unknown } | undefined
      const spec = getSpec(context.primitiveId)

      await record({
        tenantId: (ctx?.get('tenantId') as string | undefined) ?? '',
        agentId: (ctx?.get('agentId') as string | undefined) ?? null,
        conversationId: (ctx?.get('sessionId') as string | undefined) ?? null,
        primitiveId: context.primitiveId,
        runId: context.runId,
        toolCallId: context.toolCallId,
        success: context.success,
        durationMs: Math.round(context.duration ?? 0),
        errorMessage: context.error?.message ?? null,
      })

      if (!context.success) {
        // One optional fallback per spec, or none — no chains. Handing the
        // work to the fallback is the next delegation the model makes, so all
        // this does is tell the parent which one to try.
        const fallback = spec?.fallback
        context.bail()
        return {
          feedback: fallback
            ? `Delegation to "${context.primitiveId}" failed (${context.error?.message ?? 'unknown error'}). Try "${fallback}" instead, or finish with what you have.`
            : `Delegation to "${context.primitiveId}" failed (${context.error?.message ?? 'unknown error'}). Do not retry it — finish with what you have and say plainly that this step failed.`,
        }
      }

      // A sub-agent that stopped on a tool-calls step returns empty text,
      // which the parent model reads as "done, nothing to report" — a quiet
      // failure. resultText replaces what the parent sees in THIS run;
      // feedback would only reach it on the next turn.
      if (!context.result.text?.trim() && context.result.finishReason === 'tool-calls') {
        return {
          resultText: `"${context.primitiveId}" did not finish: it stopped mid-tool-call and returned nothing. Treat this as a failed step, not an empty answer.`,
        }
      }

      return undefined
    },
  }
}
```

Note on the `requestContext` cast in `onDelegationComplete`: `DelegationCompleteContext` does not declare a `requestContext` field in 1.64 the way `DelegationStartContext` does. Verify at implementation time whether one is present at runtime — if it is not, thread the tenant and conversation in from the call site closure instead (`buildDelegationConfig({ tenantId, conversationId, agentId })`) rather than reaching for `any`. The tests above must be updated to match whichever is true; keep the assertions on what is recorded, not on how it was obtained.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test hooks.test`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/hooks.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/hooks.test.ts
git commit -m "feat(subagents): delegation hooks for identity, depth, budget and audit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire the hooks and the step budget into both stream paths

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/streamOptions.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:310`
- Modify: `apps/agent-orchestrator/src/index.ts:218`
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/streamOptions.test.ts`

**Interfaces:**
- Consumes: `buildDelegationConfig` from `./hooks.js`.
- Produces: `const OLMO_MAX_STEPS = 20`, `function olmoDelegationOptions(): { maxSteps: number; delegation: DelegationConfig }`.

One shared factory rather than two literal option objects, because the two call sites drift: the allow-mode toggle already shipped wired on the SSE path and deliberately unwired on the WebSocket one, and a delegation hook silently missing on one path is far harder to notice.

`OLMO_MAX_STEPS` is the supervisor's own budget — it must be large enough to delegate several times and then answer. Mastra's untouched default is `stepCountIs(5)` (`agent-Dp3vcrIx.cjs:27699-27703`), which for a supervisor means roughly four delegations before it is cut off mid-answer.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/streamOptions.test.ts
import { describe, it, expect } from 'vitest'
import { olmoDelegationOptions, OLMO_MAX_STEPS } from '../streamOptions.js'

describe('olmoDelegationOptions', () => {
  it('carries an explicit step budget well above the Mastra default of 5', () => {
    expect(olmoDelegationOptions().maxSteps).toBe(OLMO_MAX_STEPS)
    expect(OLMO_MAX_STEPS).toBeGreaterThan(5)
  })

  it('carries both delegation hooks and the throwing error strategy', () => {
    const { delegation } = olmoDelegationOptions()
    expect(typeof delegation.onDelegationStart).toBe('function')
    expect(typeof delegation.onDelegationComplete).toBe('function')
    expect(delegation.hookErrorStrategy).toBe('throw')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test streamOptions.test`
Expected: FAIL — cannot resolve `../streamOptions.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/agent-orchestrator/src/mastra/subagents/streamOptions.ts
import type { DelegationConfig } from '@mastra/core/agent'
import { buildDelegationConfig } from './hooks.js'

/**
 * The supervisor's own step budget. Untouched, Mastra applies stepCountIs(5),
 * which for a supervisor is roughly four delegations before it is cut off
 * mid-answer. Five was never a decision anyone made; twenty is.
 */
export const OLMO_MAX_STEPS = 20

/**
 * The options every Olmo stream() call must spread in. `delegation` is a
 * per-execution option in @mastra/core 1.64 — there is no Agent-level place to
 * put it — so this exists to keep the SSE and WebSocket paths from drifting.
 */
export function olmoDelegationOptions(): { maxSteps: number; delegation: DelegationConfig } {
  return { maxSteps: OLMO_MAX_STEPS, delegation: buildDelegationConfig() }
}
```

- [ ] **Step 4: Wire the SSE path**

In `apps/agent-orchestrator/src/routes/chatStream.ts`, add the import beside the other mastra imports:

```ts
import { olmoDelegationOptions } from '../mastra/subagents/streamOptions.js'
```

and spread it into the `stream()` call at line 310:

```ts
      let currentStream: any = await (activeAgent as any).stream(mastraMessage, {
        memory: {
          thread: conversationId || crypto.randomUUID(),
          resource: tenantId,
          ...(memoryOptions ? { options: memoryOptions } : {}),
        },
        requestContext,
        providerOptions: { 'inference-gateway': { thinkingBudget } },
        ...olmoDelegationOptions(),
      })
```

- [ ] **Step 5: Wire the WebSocket path**

In `apps/agent-orchestrator/src/index.ts`, same import, and at line 218:

```ts
        const agentStream = await (platformAgent as any).stream(mastraMessage, {
          memory: { thread: conversationId ?? crypto.randomUUID(), resource: tenantId },
          requestContext,
          providerOptions: { google: { thinkingConfig: { thinkingBudget } } },
          ...olmoDelegationOptions(),
        })
```

- [ ] **Step 6: Run the full suite and type-check**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: PASS both. `activeAgent` on the SSE path may be an agent other than Olmo (pmAgent has its own delegates); passing the config is still correct — the hooks look the spec up by `primitiveId` and refuse an unregistered one, which is the behaviour Task 6 pinned.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/streamOptions.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/streamOptions.test.ts \
        apps/agent-orchestrator/src/routes/chatStream.ts \
        apps/agent-orchestrator/src/index.ts
git commit -m "feat(subagents): pass delegation hooks and an explicit step budget on both stream paths

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Background tasks

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/backgroundTasks.ts`
- Modify: `apps/agent-orchestrator/src/mastra/index.ts` (register the config)
- Modify: `apps/agent-orchestrator/src/mastra/subagents/sources.ts` (validate `background` against it)
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.background.test.ts`

**Interfaces:**
- Produces: `const BACKGROUND_TASKS: BackgroundTaskManagerConfig`, `const BACKGROUND_TASKS_ENABLED: boolean`.
- Consumes in `sources.ts`: `BACKGROUND_TASKS_ENABLED`, to reject a spec that declares `background.enabled` while the manager is off.

A spec that declares `background` while the manager is disabled declares something inert — the delegation runs inline anyway and a video-length call blocks its parent. That has to fail at boot, not at runtime.

**Verify before writing:** `BackgroundTaskManagerConfig.mode` defaults to `'full'`, which subscribes to both a dispatch topic and a result topic through PubSub (`background-tasks/types.d.ts:107-132`). Confirm what PubSub backend the manager uses when none is configured, and that a single `pm2`-managed orchestrator process is a supported `'full'` deployment. If it needs an explicit PubSub, that is part of this task, not a later surprise.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.background.test.ts
import { describe, it, expect } from 'vitest'
import { assertBackgroundSupported } from '../sources.js'
import type { SubAgentSpec } from '../spec.js'

const spec = { id: 'renderer', background: { enabled: true as const, timeoutMs: 600_000 } } as SubAgentSpec

describe('assertBackgroundSupported', () => {
  it('rejects a background spec when the manager is disabled', () => {
    expect(() => assertBackgroundSupported([spec], false)).toThrow(/backgroundTasks/)
  })

  it('accepts a background spec when the manager is enabled', () => {
    expect(() => assertBackgroundSupported([spec], true)).not.toThrow()
  })

  it('accepts specs that declare no background at all, either way', () => {
    expect(() => assertBackgroundSupported([{ id: 'pm' } as SubAgentSpec], false)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test sources.background.test`
Expected: FAIL — `assertBackgroundSupported` is not exported.

- [ ] **Step 3: Write the config module**

```ts
// apps/agent-orchestrator/src/mastra/backgroundTasks.ts
import type { BackgroundTaskManagerConfig } from '@mastra/core'

/**
 * Long-running delegations (video generation above all) must not block the
 * parent's turn. This is the one config block the harness was missing —
 * storage, scheduler, editor and observability were already registered.
 *
 * mode 'full' is the monolithic shape: this process both dispatches and
 * executes. The orchestrator runs as a single pm2 process, so producer and
 * worker are the same process.
 */
export const BACKGROUND_TASKS: BackgroundTaskManagerConfig = {
  enabled: true,
  mode: 'full',
  globalConcurrency: 10,
  perAgentConcurrency: 5,
}

export const BACKGROUND_TASKS_ENABLED = BACKGROUND_TASKS.enabled
```

- [ ] **Step 4: Register it**

In `apps/agent-orchestrator/src/mastra/index.ts`, import `BACKGROUND_TASKS` and add it to the `new Mastra({ … })` config beside `scheduler`:

```ts
  backgroundTasks: BACKGROUND_TASKS,
```

- [ ] **Step 5: Add the validation to `sources.ts`**

```ts
import { BACKGROUND_TASKS_ENABLED } from '../backgroundTasks.js'

/**
 * A spec declaring background while the manager is off declares something
 * inert: the delegation runs inline, and a video-length call blocks its
 * parent. Fail at boot instead.
 */
export function assertBackgroundSupported(specs: SubAgentSpec[], enabled = BACKGROUND_TASKS_ENABLED): void {
  if (enabled) return
  for (const spec of specs) {
    if (spec.background?.enabled) {
      throw new SubAgentSpecError(spec.id, 'declares background, but backgroundTasks is disabled on the Mastra instance')
    }
  }
}
```

and call it beside the existing `assertRegistryValid(SPECS)`:

```ts
assertRegistryValid(SPECS)
assertBackgroundSupported(SPECS)
```

- [ ] **Step 6: Run the tests and start the process**

Run: `pnpm --filter agent-orchestrator test`
Expected: PASS.

Then start the orchestrator locally and confirm it boots with no PubSub error and no unhandled rejection from the background manager's `init()`. A clean boot is the deliverable here; nothing declares `background` yet.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/backgroundTasks.ts \
        apps/agent-orchestrator/src/mastra/index.ts \
        apps/agent-orchestrator/src/mastra/subagents/sources.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/sources.background.test.ts
git commit -m "feat(mastra): enable background tasks and reject inert background specs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: The ownership marker and the allowed set

**Files:**
- Modify: `products/agent-platform/packages/schema/agents.ts` (`agentTemplates.tenantId`)
- Create: `packages/foundation/database/migrations/00XX_*.sql` (generated)
- Modify: `apps/agent-orchestrator/src/usage.ts` (add `fetchAllowedSubAgents`)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts` (set `allowedSubAgents`)
- Modify: `apps/agent-orchestrator/src/index.ts` (same, WebSocket path)
- Test: `apps/agent-orchestrator/src/__tests__/allowedSubAgents.test.ts`

**Interfaces:**
- Produces: `async function fetchAllowedSubAgents(tenantId: string, pool?): Promise<string[]>`.

`agents.tenantId` is `NOT NULL`, so a platform-owned agent has no legal home in that table. `agent_templates` gains a **nullable** `tenantId` on the `NULL means platform-owned` convention `agent_tools` already uses. Install rows are deliberately not built: before tenants can share sub-agents, "which sub-agents does this tenant have" is fully answered by *owned by the platform, or owned by me, and not retired*.

The resolver does not change when that becomes an install query. That is the whole point of it reading a set of ids out of context.

- [ ] **Step 1: Add the column**

In `products/agent-platform/packages/schema/agents.ts`, inside `agentTemplates`, after `id`:

```ts
  // NULL = platform-owned, following the convention agent_tools already uses.
  // Nullable rather than NOT NULL because a platform template belongs to no
  // tenant — the same gap that makes agents.tenantId NOT NULL wrong for
  // sub-agents. Tenant-authored templates carry their tenant here.
  tenantId: uuid('tenant_id').references(() => tenants.id),
```

- [ ] **Step 2: Generate and read the migration**

Run: `pnpm --filter @serverless-saas/database db:generate`
Expected: `ALTER TABLE "agent_templates" ADD COLUMN "tenant_id" uuid` plus its foreign key, and nothing else. Existing rows become platform-owned, which is correct — every current template is official.

- [ ] **Step 3: Write the failing test**

```ts
// apps/agent-orchestrator/src/__tests__/allowedSubAgents.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchAllowedSubAgents } from '../usage.js'

describe('fetchAllowedSubAgents', () => {
  it('asks only for platform-owned or own-tenant templates that are published', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'director' }] })
    await fetchAllowedSubAgents('t1', { query } as never)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toMatch(/tenant_id is null/i)
    expect(sql).toMatch(/status = 'published'/i)
    expect(values).toEqual(['t1'])
  })

  it('returns the code spec ids plus any rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'stylist' }] })
    const allowed = await fetchAllowedSubAgents('t1', { query } as never)
    expect(allowed).toEqual(expect.arrayContaining(['pm', 'architect', 'director', 'producer', 'stylist']))
  })

  it('returns the code spec ids when the query fails, so a DB blip does not silently strip capability', async () => {
    const query = vi.fn().mockRejectedValue(new Error('pool down'))
    expect((await fetchAllowedSubAgents('t1', { query } as never)).sort())
      .toEqual(['architect', 'director', 'pm', 'producer'])
  })
})
```

- [ ] **Step 4: Write the implementation**

In `apps/agent-orchestrator/src/usage.ts`, beside `fetchAgentName`:

```ts
/**
 * The sub-agent ids this tenant may use: every platform-owned spec, plus any
 * published template this tenant owns. Ownership only — install rows are not
 * built until tenants can share sub-agents with each other, and when they are,
 * only this function changes.
 *
 * Fails OPEN, unlike the credit checks: a bad filter here is invisible — Olmo
 * silently lacks a capability and does the job badly, with no signal to anyone
 * that something was hidden.
 */
export async function fetchAllowedSubAgents(
  tenantId: string,
  pool: { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ name: string }> }> } = getPool() as never,
): Promise<string[]> {
  const codeSpecIds = listSpecs().map(s => s.id)
  if (!tenantId) return codeSpecIds
  try {
    const res = await pool.query(
      `SELECT name FROM agent_templates
        WHERE (tenant_id IS NULL OR tenant_id = $1)
          AND status = 'published'`,
      [tenantId],
    )
    return [...new Set([...codeSpecIds, ...res.rows.map(r => r.name)])]
  } catch (err) {
    console.error(`[subagents] allowed-set lookup failed tenantId=${tenantId}, failing open:`, (err as Error).message)
    return codeSpecIds
  }
}
```

Import `listSpecs` from `./mastra/subagents/sources.js` at the top of the file.

- [ ] **Step 5: Set it on both paths**

In `chatStream.ts`, add `fetchAllowedSubAgents(tenantId)` to the existing `Promise.all` beside `fetchAgentName(agentId)`, and after it:

```ts
    requestContext.set('allowedSubAgents', allowedSubAgents)
```

Do the same in `index.ts` on the WebSocket path, beside the other `requestContext.set` calls.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/schema/agents.ts \
        packages/foundation/database/migrations \
        apps/agent-orchestrator/src/usage.ts \
        apps/agent-orchestrator/src/__tests__/allowedSubAgents.test.ts \
        apps/agent-orchestrator/src/routes/chatStream.ts \
        apps/agent-orchestrator/src/index.ts
git commit -m "feat(subagents): mark template ownership and load the allowed set per request

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: The throwaway smoke consumer

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/subagents/stub.ts`
- Modify: `apps/agent-orchestrator/src/mastra/subagents/sources.ts` (register it behind an env flag)
- Test: `apps/agent-orchestrator/src/mastra/subagents/__tests__/stub.test.ts`

**Interfaces:**
- Produces: `const stubSpec: SubAgentSpec`, `const STUB_ENABLED: boolean` (from `process.env.SUBAGENT_SMOKE_STUB === '1'`).

This delegate exists to exercise the control plane end to end and is **deleted when the marketing vertical lands**. It is cheap, deterministic, and does one thing no real delegate does: it can be asked to fail on purpose, which is the only way to see the failure half of the hooks without breaking a real agent.

It is registered only when `SUBAGENT_SMOKE_STUB=1`, so it never appears in a tenant's delegate list by accident.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/subagents/__tests__/stub.test.ts
import { describe, it, expect } from 'vitest'
import { stubSpec } from '../stub.js'
import { NEGATIVE_CLAUSE } from '../spec.js'

describe('smoke stub spec', () => {
  it('is a valid spec with a discriminating description', () => {
    expect(NEGATIVE_CLAUSE.test(stubSpec.description)).toBe(true)
    expect(stubSpec.id).toBe('smoke')
  })

  it('costs nothing, so the credit gate can be tested by lowering a balance rather than by spending', () => {
    expect(stubSpec.estimatedCredits).toBe(0)
  })

  it('cannot re-delegate', () => {
    expect(stubSpec.maxDepth).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test stub.test`
Expected: FAIL — cannot resolve `../stub.js`.

- [ ] **Step 3: Write the stub**

```ts
// apps/agent-orchestrator/src/mastra/subagents/stub.ts
import { Agent } from '@mastra/core/agent'
import { defineSubAgent } from './spec.js'
import { selectModel } from '../agents/modelSelection.js'

/**
 * THROWAWAY. Exists to exercise the control plane — hooks, depth, budget,
 * link row — before any real specialist does. Delete this file and its
 * registration when the marketing vertical lands.
 *
 * Registered only when SUBAGENT_SMOKE_STUB=1.
 */
export const STUB_ENABLED = process.env.SUBAGENT_SMOKE_STUB === '1'

const stubAgent = new Agent({
  id: 'smoke',
  name: 'smoke',
  description: 'Throwaway smoke-test delegate.',
  instructions: `You are a smoke-test delegate for the sub-agent control plane. Reply with exactly one short sentence describing what you were asked to do. If the prompt contains the word FAIL, throw by calling no tool and replying with the single word FAILED.`,
  model: selectModel,
})

export const stubSpec = defineSubAgent({
  id: 'smoke',
  build: () => stubAgent as unknown as Agent,
  description: 'Echoes back a one-line description of the task, for testing the delegation plumbing. Not for any real user work — never use it to answer a question.',
  tags: ['internal'],
  maxSteps: 2,
  estimatedCredits: 0,
})
```

- [ ] **Step 4: Register it behind the flag**

In `sources.ts`, after the four specs:

```ts
import { stubSpec, STUB_ENABLED } from './stub.js'

// …
const SPECS: SubAgentSpec[] = [
  // …the four…
  ...(STUB_ENABLED ? [stubSpec] : []),
]
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm --filter agent-orchestrator test`
Expected: PASS. The `sources.test.ts` assertion on exactly four ids still holds, because the flag is unset in tests.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/subagents/stub.ts \
        apps/agent-orchestrator/src/mastra/subagents/__tests__/stub.test.ts \
        apps/agent-orchestrator/src/mastra/subagents/sources.ts
git commit -m "feat(subagents): add a throwaway smoke-consumer delegate behind a flag

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Live verification

**Files:** none — this task produces evidence, not code. Anything it turns up that needs fixing becomes a change to the task that owns it.

Run the orchestrator locally with `SUBAGENT_SMOKE_STUB=1` against a dev tenant, talking to Olmo in chat. All six must be observable; a checked box means it was seen, not assumed.

- [ ] **1. One link row per delegation.** Ask Olmo to use the smoke delegate. Then:

```sql
SELECT primitive_id, success, duration_ms, rejection_reason, error_message
  FROM agent_delegations WHERE tenant_id = '<dev tenant>' ORDER BY created_at DESC LIMIT 5;
```

Expected: exactly one row for the delegation, `success = true`, a non-zero `duration_ms`.

- [ ] **2. A delegation over budget is refused before it runs.** Set the dev tenant's balance below `director`'s `estimatedCredits`, ask for an image, and confirm Olmo says it is out of credits **without** an image being generated. A row lands with `success = false` and the reason in `rejection_reason`.

- [ ] **3. A delegate at the depth limit has an empty map.** In the smoke delegate's turn, confirm from the logs that `resolveDelegates` returned `{}` — its context carries `delegationDepth: 1`, and `maxDepthForHost('smoke')` is `0`.

- [ ] **4. A delegate takes the step count its spec declares.** Confirm the delegated run is capped at the spec's `maxSteps`, not five. The observability span for the delegation carries the step count.

- [ ] **5. A crashing hook fails the delegation.** Temporarily make `recordDelegation` throw instead of swallowing, delegate, and confirm the delegation fails rather than completing quietly. Revert the change.

- [ ] **6. Identity does not leak.** Confirm from the delegated run that `agentId` is the delegate's own and `agentSystemPrompt` is empty — the assertion Task 6 makes in a unit test, seen once for real, because Finding 1 shows the default is to inherit all three.

- [ ] **Step 7: Record the outcome**

Append a short "Verified in dev, <date>" section to the spec listing which of the six were seen and anything that had to change. Commit the spec edit alone.

---

## Task 12: Resolve the `foreach` suspend/resume question

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-subagent-control-plane-design.md` (record the answer)

The spec's section 5 says *"Confirm before planning"* about one thing, and it is still unconfirmed. That is why the goal/task loop is **not** in this plan: it depends on an answer nobody has.

The question: the task workflow is a `.foreach()` over a per-task plan, so "the step that runs the goal" is one step definition executed many times. Does a step suspend *inside* a `foreach` body, and does `resume()` land on the correct iteration?

- [ ] **Step 1: Read what the installed docs say**

```bash
grep -rn "foreach" node_modules/.pnpm/@mastra+core@1.64.0*/node_modules/@mastra/core/dist/docs/references/*workflow* | head -40
```

- [ ] **Step 2: Write a throwaway workflow that proves or disproves it**

A two-item `.foreach()` whose body suspends on the second item, run through `createRunAsync()` / `run.start()` / `run.resume()`, asserting which iteration the resumed run re-enters. This is a spike: it lives in a scratch file and is deleted, not committed.

- [ ] **Step 3: Also settle paused vs blocked**

Mastra workflow run status is `success | failed | suspended | tripwire | paused`, with `suspended` and `paused` as separate states, but the installed docs do not say what `paused` means. Find out. If it already means "waiting, resumable, not broken", the work is adopting a state Mastra has rather than inventing one — and the watchdog's *"Task timed out. The agent may have crashed. Please retry."* must stop being shown to a user whose job simply ran out of credits.

- [ ] **Step 4: Write the answer into the spec and commit**

Replace the two bullets under "Two consequences of that shape" with what was actually observed. Then the goal/task-loop work becomes its own plan, written against a settled mechanism.

---

## What this plan deliberately leaves out

- **The marketing/ad-creative agents, their skills and the ad rubric.** The vertical this control plane exists to serve, and its own spec.
- **The `goal` loop, the chat-to-task boundary, and paused-vs-blocked.** Blocked on Task 12's answer; a separate plan once it lands.
- **A database-backed sub-agent registry.** `build: () => Agent` is the seam; the schema is not designed until a delegate has run under hooks and a budget.
- **Intent-based filtering.** A seam in `resolveDelegates`, not a mechanism. `classifierAgent` is not reusable for it — it is a document classifier with one caller.
- **Fallback chains and self-healing.** One optional fallback target per spec.
- **Install rows.** Not needed until tenants can share sub-agents.
