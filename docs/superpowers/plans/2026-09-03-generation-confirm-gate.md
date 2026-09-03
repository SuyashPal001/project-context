# Generation Confirm Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the user a cost/balance confirmation (Confirm/Cancel) before any of the four generation tools (`generate_image`, `edit_image`, `generate_song`, `generate_video`) spends credits, instead of charging silently and only revealing cost after the fact.

**Architecture:** Mirrors the already-shipped `ask_clarifying_questions` in-process pause/resume pattern (`sendEvent` + an awaited Promise resolved via a pending-request map, with a timeout) rather than the MCP write-tool approval gate's HTTP round-trip (that gate exists only because `mcp-server` is a separate out-of-process service — generation tools already run in-process with everything `ask_clarifying_questions` reads today). Reuses the already-shipped `ApproveCost` component and `GET /credits/estimate` endpoint for the cost/balance/sufficiency display instead of building a new one. Charge-after-success is untouched — this only adds a pause *before* the gateway call; rate resolution at charge time stays exactly where it is.

**Tech Stack:** TypeScript, Mastra, Hono, Drizzle ORM, Vitest, React Query, Next.js.

**Spec:** [docs/superpowers/specs/2026-09-03-generation-confirm-gate-design.md](../specs/2026-09-03-generation-confirm-gate-design.md)

## Global Constraints

- All four generation tools get the gate: `generate_image`, `edit_image`, `generate_song`, `generate_video`.
- Unlimited tenants (`isUnlimited(tenantId)` true) skip the gate entirely — no card, no event, no pause.
- No active credit rate for `(resourceType, subject)` also skips the gate (matches the existing `UNBILLED` log-and-proceed precedent at charge time).
- No active SSE session (`sendEvent`/`sessionId`/`tenantId`/`userId` missing from `requestContext`) also skips the gate, proceeding uncompromised — mirrors `askClarifyingQuestionsTool`'s own guard.
- Timeout is 5 minutes (`300_000` ms), resolving to declined (not confirmed) on expiry.
- New refusal reason `'DECLINED'` added to all four tools' vocabulary; each agent's instructions get an explicit line for it.
- **No rate-resolution reordering in the tools.** The existing post-success `isUnlimited` → `resolveRate` → `costMicro` → `spendCredits` block in each tool stays byte-for-byte where it is today. The confirm-time cost shown to the user is independently resolved via `GET /credits/estimate` (already documented there as "a preview, not a reservation").
- At most one pending confirm per SSE session — a second concurrent request declines immediately rather than queuing (see Task 6).
- `apps/agent-orchestrator` and `apps/web` changes need `pm2 restart`/`./deploy.sh` respectively; the schema/messages.ts changes go through the API Lambda and need `sam deploy` (rebuild `packages/foundation/*`/product `dist/` first — the stale-`dist/` footgun).

---

### Task 1: Widen credit resource-type allowlists

**Files:**
- Modify: `apps/api/src/routes/credits.ts:16`
- Modify: `apps/web/lib/hooks/useCredits.ts:35`
- Test: `apps/api/src/routes/__tests__/credits.test.ts`

**Interfaces:**
- Produces: `GET /credits/estimate` accepts `resourceType` values `image_generation`, `music_generation`, `video_generation` (already valid in the DB enum at `packages/foundation/database/schema/credits.ts:18`, just not in this route's allowlist). `CreditResourceType` (web) widened to match, so `ApproveCost`'s `resourceType` prop accepts these values without a TypeScript error.

- [ ] **Step 1: Write the failing test**

Open `apps/api/src/routes/__tests__/credits.test.ts` and find the existing test(s) for `GET /credits/estimate` with a valid `resourceType` (e.g. `'llm_tokens'`) to match the file's existing mocking/setup pattern. Add:

```ts
  it('accepts image_generation as a valid resourceType', async () => {
    // Use the same request-building helper / app setup the file's other
    // /credits/estimate tests use, substituting resourceType=image_generation
    // and a subject that resolves via resolveRate mocked to return a rate.
    const res = await app.request('/credits/estimate?resourceType=image_generation&subject=gemini-3-pro-image-preview&count=1', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).not.toBe(400)
  })
```

(Adapt the exact request-construction and auth-header shape to match whatever pattern the file's existing `/credits/estimate` tests already use — read the file first, this is illustrative of the assertion, not a literal drop-in.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/routes/__tests__/credits.test.ts -t "image_generation"`
Expected: FAIL — the current `RESOURCE_TYPES` allowlist rejects `image_generation` via the zod `z.enum(RESOURCE_TYPES)` validation, producing a 400.

- [ ] **Step 3: Widen the allowlist**

In `apps/api/src/routes/credits.ts:16`:

```ts
const RESOURCE_TYPES = ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation', 'music_generation', 'video_generation'] as const;
```

- [ ] **Step 4: Widen the matching frontend type**

In `apps/web/lib/hooks/useCredits.ts:35`:

```ts
export type CreditResourceType = 'llm_tokens' | 'message' | 'tool_call' | 'skill_run' | 'image_generation' | 'music_generation' | 'video_generation';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/routes/__tests__/credits.test.ts -t "image_generation"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/credits.ts apps/web/lib/hooks/useCredits.ts apps/api/src/routes/__tests__/credits.test.ts
git commit -m "feat(credits): widen /credits/estimate to accept generation resource types"
```

---

### Task 2: Orchestrator state — types and pending maps

**Files:**
- Modify: `apps/agent-orchestrator/src/types.ts`

**Interfaces:**
- Produces: `GenerationConfirmRequest` interface, `pendingGenerationConfirmations` map, `sessionActiveGenerationConfirmations` map — consumed by Task 3 (persistence), Task 6 (shared helper), Task 7 (decision route + stream-cancel cleanup).

No test for this task — pure additive type/state declarations, exercised indirectly by every later task's tests. Mirrors the existing `ClarificationAnswer`/`sessionActiveClarification`/`pendingClarifications` block already in this file (`types.ts:96-120`).

- [ ] **Step 1: Add the type and maps**

In `apps/agent-orchestrator/src/types.ts`, after the existing `pendingClarifications` block (around line 120), add:

```ts
// Generation confirm gate — mirrors the clarification-question pattern above,
// generalized to a single pending yes/no decision per generation tool call
// rather than an ordered array of question answers.
export interface GenerationConfirmRequest {
  id: string
  resourceType: string
  subject: string
  label: string
  status: 'pending' | 'approved' | 'declined'
  decisionAt?: string
}

// Lets the stream cancel() handler find and resolve every live pending
// confirmation for a given SSE session without scanning the entire
// pendingGenerationConfirmations map. A Set, not a single value like
// sessionActiveClarification, because the concurrency guard in
// confirmGenerationOrDecline (Task 6) needs to check "is anything already
// pending for this session" before adding a new one.
export const sessionActiveGenerationConfirmations = new Map<string, Set<string>>()

export const pendingGenerationConfirmations = new Map<string, {
  resolve: (confirmed: boolean) => void
  timer: ReturnType<typeof setTimeout>
  tenantId: string
  messageId?: string
  conversationId?: string
  idToken?: string
}>()
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no new errors (this repo has pre-existing unrelated errors elsewhere — confirm none are newly introduced by this addition).

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/types.ts
git commit -m "feat(agent-orchestrator): add generation confirm gate state"
```

---

### Task 3: Orchestrator persistence — save/update generation confirm request

**Files:**
- Modify: `apps/agent-orchestrator/src/persistence.ts`
- Test: `apps/agent-orchestrator/src/persistence.test.ts`

**Interfaces:**
- Consumes: `GenerationConfirmRequest` from `./types.js` (Task 2).
- Produces: `saveGenerationConfirmRequest(idToken, conversationId, messageId, request: GenerationConfirmRequest): void` and `updateGenerationConfirmRequest(idToken, conversationId, messageId, update: Pick<GenerationConfirmRequest, 'status' | 'decisionAt'>): void`, consumed by Task 6 (shared helper) and Task 7 (decision route).

- [ ] **Step 1: Write the failing test**

Read `apps/agent-orchestrator/src/persistence.test.ts` first to find its existing test(s) for `saveApprovalRequest`/`updateApprovalRequest` (same shape, closest sibling) and match its mocking pattern (likely `vi.stubGlobal('fetch', ...)` or similar). Add:

```ts
describe('saveGenerationConfirmRequest', () => {
  it('POSTs to /messages/save with the generationConfirmRequest field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 })
    vi.stubGlobal('fetch', fetchMock)

    saveGenerationConfirmRequest('tok', 'conv-1', 'msg-1', {
      id: 'gc-1', resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
      label: 'Generate image', status: 'pending',
    })

    // fire-and-forget — give the microtask queue a tick
    await new Promise(r => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/conversations/conv-1/messages/save')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.generationConfirmRequest).toEqual({
      id: 'gc-1', resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview',
      label: 'Generate image', status: 'pending',
    })
  })
})

describe('updateGenerationConfirmRequest', () => {
  it('PATCHes /messages/:messageId/generation-confirm with the status update', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    updateGenerationConfirmRequest('tok', 'conv-1', 'msg-1', { status: 'approved', decisionAt: '2026-09-03T00:00:00.000Z' })

    await new Promise(r => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/conversations/conv-1/messages/msg-1/generation-confirm')
    expect((opts as RequestInit).method).toBe('PATCH')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.generationConfirmRequest).toEqual({ status: 'approved', decisionAt: '2026-09-03T00:00:00.000Z' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/persistence.test.ts -t "GenerationConfirm"`
Expected: FAIL — `saveGenerationConfirmRequest`/`updateGenerationConfirmRequest` not exported yet.

- [ ] **Step 3: Implement**

In `apps/agent-orchestrator/src/persistence.ts`, after the existing `updateApprovalRequest` function (around line 208), add:

```ts
export interface GenerationConfirmRequestPayload {
  id: string
  resourceType: string
  subject: string
  label: string
  status: 'pending' | 'approved' | 'declined'
  decisionAt?: string
}

export function saveGenerationConfirmRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  generationConfirmRequest: GenerationConfirmRequestPayload,
): void {
  const payload = {
    id: messageId,
    role: 'assistant',
    content: '',
    generationConfirmRequest,
    createdAt: new Date().toISOString(),
  }
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/save`, {
    method: 'POST',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] saveGenerationConfirmRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] saveGenerationConfirmRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] saveGenerationConfirmRequest error:', err.message)
  })
}

export function updateGenerationConfirmRequest(
  idToken: string,
  conversationId: string,
  messageId: string,
  update: Pick<GenerationConfirmRequestPayload, 'status' | 'decisionAt'>,
): void {
  fetch(`${API_BASE}/api/v1/conversations/${conversationId}/messages/${messageId}/generation-confirm`, {
    method: 'PATCH',
    headers: { ...authHeaders(idToken), 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ generationConfirmRequest: update }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[persistence] updateGenerationConfirmRequest status: ${res.status} body: ${body}`)
    } else {
      console.log('[persistence] updateGenerationConfirmRequest status:', res.status)
    }
  }).catch((err: Error) => {
    console.error('[persistence] updateGenerationConfirmRequest error:', err.message)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/persistence.test.ts -t "GenerationConfirm"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/persistence.test.ts
git commit -m "feat(agent-orchestrator): add generation confirm request persistence"
```

---

### Task 4: DB schema column + migration

**Files:**
- Modify: `products/agent-platform/packages/schema/conversations.ts`
- Create: a new Drizzle migration (via `drizzle-kit generate`)

**Interfaces:**
- Produces: `messages.generationConfirmRequest` (jsonb column), consumed by Task 5.

- [ ] **Step 1: Add the column**

In `products/agent-platform/packages/schema/conversations.ts`, find the existing `approvalRequest: jsonb('approval_request')` line (around line 63) and add directly after it:

```ts
  generationConfirmRequest: jsonb('generation_confirm_request'),
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd packages/foundation/database && pnpm exec drizzle-kit generate
```
Expected: unlike the earlier `resourceType` text-enum change, this **is** real DDL (a new jsonb column) — a migration file should be generated this time (`ALTER TABLE messages ADD COLUMN generation_confirm_request jsonb;`). If drizzle-kit reports no changes, check that `conversations.ts` is actually part of the schema barrel `drizzle-kit` reads from — it's a product-schema file, confirm the drizzle config includes `products/agent-platform/packages/schema` in its schema glob before assuming this step is done.

- [ ] **Step 3: Apply the migration against the dev database**

```bash
pnpm exec drizzle-kit migrate
```
Expected: applies without error.

- [ ] **Step 4: Commit**

```bash
git add products/agent-platform/packages/schema/conversations.ts packages/foundation/database/migrations/
git commit -m "feat(schema): add generation_confirm_request column to messages"
```

---

### Task 5: API Lambda — messages.ts zod field, insert, and PATCH route

**Files:**
- Modify: `products/agent-platform/packages/api/routes/messages.ts`
- Test: `products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts`

**Interfaces:**
- Consumes: `messages.generationConfirmRequest` column from Task 4.
- Produces: `POST /messages/save` accepts a `generationConfirmRequest` field; `PATCH /:conversationId/messages/:messageId/generation-confirm` updates it. Consumed by Task 3's persistence functions (already written; this task makes the endpoints they call actually work) and Task 7.

- [ ] **Step 1: Write the failing test**

Create `products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts`, following `messages.save.test.ts`'s mocking pattern (read that file first — same `vi.mock` calls for `../db`, `@serverless-saas/agent-schema/conversations`, `@serverless-saas/permissions`, and the service-key constant):

```ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/conversations', () => ({
  conversations: {}, messages: {},
}))
vi.mock('@serverless-saas/database/schema/billing', () => ({ usageRecords: {} }))
vi.mock('./_orchestrator', () => ({}))
vi.mock('../routes/_orchestrator', () => ({
  runMessageRelay: vi.fn(),
  RelayError: class extends Error {},
}))
vi.mock('@serverless-saas/permissions', () => ({
  hasPermission: () => true,
}))

const SERVICE_KEY = 's'.repeat(40)

describe('PATCH /:conversationId/messages/:messageId/generation-confirm', () => {
  it('requires x-internal-service-key', async () => {
    const { messagesRoutes } = await import('../routes/messages')
    const app = new Hono<any>()
    app.use('*', async (c, next) => {
      c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] })
      c.set('userId', 'user-1')
      await next()
    })
    app.route('/', messagesRoutes)

    const res = await app.request('/conv-1/messages/msg-1/generation-confirm', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generationConfirmRequest: { status: 'approved' } }),
    })

    expect(res.status).toBe(401)
  })

  it('rejects a body with no generationConfirmRequest.status', async () => {
    const { messagesRoutes } = await import('../routes/messages')
    const app = new Hono<any>()
    app.use('*', async (c, next) => {
      c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] })
      c.set('userId', 'user-1')
      await next()
    })
    app.route('/', messagesRoutes)

    const res = await app.request('/conv-1/messages/msg-1/generation-confirm', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': SERVICE_KEY },
      body: JSON.stringify({ generationConfirmRequest: {} }),
    })

    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/messages.generation-confirm.test.ts`
Expected: FAIL — the route doesn't exist yet, both requests 404.

- [ ] **Step 3: Add the zod field, insert, and new PATCH route**

In `products/agent-platform/packages/api/routes/messages.ts`:

Find the `POST /messages/save` schema (around line 162-176, right after `clarificationRequest`/before `createdAt`) and add:

```ts
        generationConfirmRequest: z.object({
            id: z.string(),
            resourceType: z.string(),
            subject: z.string(),
            label: z.string(),
            status: z.enum(['pending', 'approved', 'declined']),
            decisionAt: z.string().optional(),
        }).nullish(),
```

Find the insert (`.values({...})`, around line 224-236, right after the `approvalRequest:` line) and add:

```ts
            generationConfirmRequest: result.data.generationConfirmRequest ?? null,
```

After the existing `PATCH /:conversationId/messages/:messageId/approval` route (ends around line 384), add a new route with the identical shape, substituting the field name:

```ts
// PATCH /conversations/:conversationId/messages/:messageId/generation-confirm — update generation confirm status
// Internal only: called by the orchestrator when the user confirms or declines a generation.
messagesRoutes.patch('/:conversationId/messages/:messageId/generation-confirm', async (c) => {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');

    const schema = z.object({
        generationConfirmRequest: z.object({
            status: z.enum(['pending', 'approved', 'declined']),
            decisionAt: z.string().optional(),
        }),
    });

    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [existing] = await db
        .select({ generationConfirmRequest: messages.generationConfirmRequest })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .limit(1);

    if (!existing) return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);

    const merged = { ...(existing.generationConfirmRequest as object ?? {}), ...result.data.generationConfirmRequest };

    const [updated] = await db
        .update(messages)
        .set({ generationConfirmRequest: merged })
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .returning();

    return c.json({ data: updated }, 200);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/messages.generation-confirm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/messages.ts products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts
git commit -m "feat(api): add generation confirm request field and PATCH route"
```

---

### Task 6: Shared helper — confirmGenerationOrDecline

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.test.ts`

**Interfaces:**
- Consumes: `isUnlimited`, `resolveRate` from `@serverless-saas/credits`; `pendingGenerationConfirmations`, `sessionActiveGenerationConfirmations`, `GenerationConfirmRequest` from `../../types.js` (Task 2); `saveGenerationConfirmRequest` from `../../persistence.js` (Task 3).
- Produces: `confirmGenerationOrDecline(execContext, resourceType: string, subject: string, label: string): Promise<{ confirmed: boolean }>`, consumed by Task 8 (the four tools) and by Task 7's stream-cancel cleanup (which resolves entries this function registers).

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { isUnlimited, resolveRate, saveGenerationConfirmRequest, updateGenerationConfirmRequest } = vi.hoisted(() => ({
  isUnlimited: vi.fn(),
  resolveRate: vi.fn(),
  saveGenerationConfirmRequest: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({ isUnlimited, resolveRate }))
vi.mock('../../persistence.js', () => ({ saveGenerationConfirmRequest, updateGenerationConfirmRequest }))

import { confirmGenerationOrDecline } from './confirmGeneration.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../../types.js'

function ctx(values: Record<string, unknown>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const sendEvent = vi.fn()
const baseCtx = () => ctx({
  tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent,
})

beforeEach(() => {
  vi.resetAllMocks()
  pendingGenerationConfirmations.clear()
  sessionActiveGenerationConfirmations.clear()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('confirmGenerationOrDecline', () => {
  it('skips the gate for an unlimited tenant — no sendEvent', async () => {
    isUnlimited.mockResolvedValue(true)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when no active rate resolves — no sendEvent', async () => {
    resolveRate.mockResolvedValue(null)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when there is no active session — no sendEvent', async () => {
    const noSessionCtx = ctx({ tenantId: 't1' }) // missing sendEvent/sessionId/userId
    const result = await confirmGenerationOrDecline(noSessionCtx, 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
  })

  it('sends the event, persists, and resolves confirmed when the pending map is resolved with true', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({
      resourceType: 'image_generation', subject: 'model-x', label: 'Generate image',
    }))
    expect(saveGenerationConfirmRequest).toHaveBeenCalledTimes(1)

    const [[confirmationId]] = sessionActiveGenerationConfirmations.get('s1')
      ? [Array.from(sessionActiveGenerationConfirmations.get('s1')!)]
      : [[]]
    const pending = pendingGenerationConfirmations.get(confirmationId)
    pending!.resolve(true)

    const result = await promise
    expect(result).toEqual({ confirmed: true })
  })

  it('resolves declined when the pending map is resolved with false', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve(false)

    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('auto-declines after the 5-minute timeout', async () => {
    vi.useFakeTimers()
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.advanceTimersByTimeAsync(300_000)
    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('declines a second concurrent request for the same session without sending a second event', async () => {
    const first = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))

    const second = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(second).toEqual({ confirmed: false })
    expect(sendEvent).toHaveBeenCalledTimes(1) // still just the first

    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve(true)
    await first
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/confirmGeneration.test.ts`
Expected: FAIL — `Cannot find module './confirmGeneration.js'`.

- [ ] **Step 3: Implement**

Create `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { isUnlimited, resolveRate } from '@serverless-saas/credits'
import { saveGenerationConfirmRequest, updateGenerationConfirmRequest } from '../../persistence.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../../types.js'

const CONFIRM_TIMEOUT_MS = 300_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function confirmGenerationOrDecline(
  execContext: any,
  resourceType: string,
  subject: string,
  label: string,
): Promise<{ confirmed: boolean }> {
  const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
  const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
  const userId = execContext?.requestContext?.get('userId') as string | undefined
  const sendEvent = execContext?.requestContext?.get('sendEvent') as
    ((event: string, data: object) => void) | undefined
  const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
  const idToken = execContext?.requestContext?.get('idToken') as string | undefined

  // No active session — mirrors askClarifyingQuestionsTool's own guard.
  // Not reachable today (Director/Producer only run via chatStream.ts's
  // live-session path); included so this doesn't hang or throw the day
  // these tools become reachable from a non-SSE context.
  if (!sendEvent || !sessionId || !tenantId || !userId) {
    return { confirmed: true }
  }

  if (await isUnlimited(tenantId)) {
    return { confirmed: true }
  }

  const rate = await resolveRate(resourceType, subject)
  if (!rate) {
    return { confirmed: true }
  }

  // At most one pending confirm per session — a second concurrent request
  // declines immediately rather than queuing. MessageThread.tsx's overlay
  // only ever considers the last message, so a second simultaneous card
  // would have no UI to render into; see spec §5.
  const existing = sessionActiveGenerationConfirmations.get(sessionId)
  if (existing && existing.size > 0) {
    return { confirmed: false }
  }

  const confirmationId = randomUUID()
  const confirmMessageId = randomUUID()
  sendEvent('generation_confirm_request', { confirmationId, resourceType, subject, label })

  if (conversationId && idToken) {
    saveGenerationConfirmRequest(idToken, conversationId, confirmMessageId, {
      id: confirmationId, resourceType, subject, label, status: 'pending',
    })
  }

  let sessionSet = sessionActiveGenerationConfirmations.get(sessionId)
  if (!sessionSet) {
    sessionSet = new Set()
    sessionActiveGenerationConfirmations.set(sessionId, sessionSet)
  }
  sessionSet.add(confirmationId)

  const confirmed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingGenerationConfirmations.get(confirmationId)
      pendingGenerationConfirmations.delete(confirmationId)
      sessionActiveGenerationConfirmations.get(sessionId)?.delete(confirmationId)
      resolve(false)

      if (pending?.messageId && pending?.conversationId && pending?.idToken) {
        updateGenerationConfirmRequest(pending.idToken, pending.conversationId, pending.messageId, {
          status: 'declined',
          decisionAt: new Date().toISOString(),
        })
      }
    }, CONFIRM_TIMEOUT_MS)
    pendingGenerationConfirmations.set(confirmationId, {
      resolve, timer, tenantId,
      messageId: confirmMessageId,
      conversationId,
      idToken,
    })
  })

  return { confirmed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/confirmGeneration.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts apps/agent-orchestrator/src/mastra/tools/confirmGeneration.test.ts
git commit -m "feat(agent-orchestrator): add confirmGenerationOrDecline shared helper"
```

---

### Task 7: Orchestrator decision route + SSE stream-cancel cleanup

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/sessions.ts`
- Modify: `apps/agent-orchestrator/src/routes/chat.ts`
- Test: `apps/agent-orchestrator/src/routes/sessions.test.ts` (new)

**Interfaces:**
- Consumes: `pendingGenerationConfirmations`, `sessionActiveGenerationConfirmations` from `../types.js` (Task 2); `updateGenerationConfirmRequest` from `../persistence.js` (Task 3).
- Produces: `POST /api/chat/generation-confirm` HTTP endpoint (called by the frontend, Task 10). No new exports consumed by other backend tasks.

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/routes/sessions.test.ts`, mirroring the shape of the existing `/api/chat/approval` route it sits beside (read `sessions.ts:103-149` first for the exact behavior to test against):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { validateToken, updateGenerationConfirmRequest } = vi.hoisted(() => ({
  validateToken: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))
vi.mock('../auth.js', () => ({ validateToken }))
vi.mock('../persistence.js', () => ({
  updateClarificationRequest: vi.fn(),
  saveApprovalRequest: vi.fn(),
  updateApprovalRequest: vi.fn(),
  updateGenerationConfirmRequest,
}))

import { sessionsRouter } from './sessions.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../types.js'

const app = new Hono()
app.route('/', sessionsRouter)

beforeEach(() => {
  vi.resetAllMocks()
  pendingGenerationConfirmations.clear()
  sessionActiveGenerationConfirmations.clear()
})

describe('POST /api/chat/generation-confirm', () => {
  it('requires a bearer token', async () => {
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(401)
  })

  it('resolves the pending confirmation and persists approved', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', {
      resolve, timer, tenantId: 't1', messageId: 'm1', conversationId: 'c1', idToken: 'tok',
    })
    sessionActiveGenerationConfirmations.set('s1', new Set(['gc-1']))

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })

    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith(true)
    expect(pendingGenerationConfirmations.has('gc-1')).toBe(false)
    expect(updateGenerationConfirmRequest).toHaveBeenCalledWith('tok', 'c1', 'm1', expect.objectContaining({ status: 'approved' }))
    clearTimeout(timer)
  })

  it('404s for an unknown confirmationId', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'nope', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
  })

  it('404s when the caller tenant does not match the pending confirmation tenant', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 'other-tenant' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', { resolve, timer, tenantId: 't1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'approved' }),
    })
    expect(res.status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
    clearTimeout(timer)
  })

  it('resolves declined for decision=declined', async () => {
    validateToken.mockResolvedValue({ 'custom:tenantId': 't1' })
    const resolve = vi.fn()
    const timer = setTimeout(() => {}, 999_999)
    pendingGenerationConfirmations.set('gc-1', { resolve, timer, tenantId: 't1' })

    const res = await app.request('/api/chat/generation-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ confirmationId: 'gc-1', decision: 'declined' }),
    })
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/sessions.test.ts`
Expected: FAIL — the route doesn't exist, all requests 404 with the wrong body shape (or the test harness errors on missing behavior).

- [ ] **Step 3: Add the decision route**

In `apps/agent-orchestrator/src/routes/sessions.ts`, add the import for the new state and persistence function at the top (extend the existing `import { ... } from '../types.js'` and `import { ... } from '../persistence.js'` lines), then add a new route after the existing `/api/chat/clarification` route (end of file):

```ts
// ─── Generation confirm decision — called by frontend after user confirms/declines ──
sessionsRouter.post('/api/chat/generation-confirm', async (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)

  let callerTenantId = ''
  try {
    const payload = await validateToken(token)
    callerTenantId = payload['custom:tenantId'] ?? ''
  } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)
  }

  let body: { confirmationId?: unknown; decision?: unknown }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid_body' }, 400, corsHeaders) }

  const confirmationId = typeof body.confirmationId === 'string' ? body.confirmationId.trim() : ''
  const decision        = typeof body.decision === 'string' ? body.decision.trim() : ''
  if (!confirmationId) return c.json({ ok: false, error: 'confirmationId required' }, 400, corsHeaders)

  const pending = pendingGenerationConfirmations.get(confirmationId)
  if (!pending) return c.json({ ok: false, error: 'confirmation_not_found' }, 404, corsHeaders)
  if (!callerTenantId || pending.tenantId !== callerTenantId) {
    return c.json({ ok: false, error: 'confirmation_not_found' }, 404, corsHeaders)
  }

  clearTimeout(pending.timer)
  pendingGenerationConfirmations.delete(confirmationId)
  // Find which session this belongs to and clear it from the active-set index too.
  for (const [sessionId, ids] of sessionActiveGenerationConfirmations.entries()) {
    if (ids.delete(confirmationId) && ids.size === 0) {
      sessionActiveGenerationConfirmations.delete(sessionId)
    }
  }

  const wasApproved = decision === 'approved'
  pending.resolve(wasApproved)

  if (pending.messageId && pending.conversationId && pending.idToken) {
    updateGenerationConfirmRequest(pending.idToken, pending.conversationId, pending.messageId, {
      status: wasApproved ? 'approved' : 'declined',
      decisionAt: new Date().toISOString(),
    })
  }

  return c.json({ ok: true }, 200, corsHeaders)
})
```

Also add an `OPTIONS` preflight handler for the new path, mirroring the existing `/api/chat/approval` OPTIONS block near the top of the file:

```ts
sessionsRouter.options('/api/chat/generation-confirm', (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/sessions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Add stream-cancel cleanup in chat.ts**

In `apps/agent-orchestrator/src/routes/chat.ts`, extend the existing imports:

```ts
import {
  Attachment,
  getAllowedOrigin, INTERNAL_SERVICE_KEY, API_BASE_URL,
  sseApprovalChannels,
  sessionActiveClarification, pendingClarifications,
  sessionActiveGenerationConfirmations, pendingGenerationConfirmations,
  checkRateLimit,
} from '../types.js'
import { updateClarificationRequest, updateGenerationConfirmRequest } from '../persistence.js'
```

In the `cancel()` handler (`chat.ts:202-232`), after the existing clarification-resolution block and before the closing brace of `cancel()`, add:

```ts
      // Resolve every pending generation confirmation for this session
      // immediately, same reasoning as the clarification block above — don't
      // leave the agent blocked for up to 5 minutes after the client is gone.
      const confirmIds = sessionActiveGenerationConfirmations.get(sessionId)
      if (confirmIds) {
        for (const confirmationId of Array.from(confirmIds)) {
          const pending = pendingGenerationConfirmations.get(confirmationId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingGenerationConfirmations.delete(confirmationId)
            pending.resolve(false)
            if (pending.messageId && pending.conversationId && pending.idToken) {
              updateGenerationConfirmRequest(pending.idToken, pending.conversationId, pending.messageId, {
                status: 'declined',
                decisionAt: new Date().toISOString(),
              })
            }
          }
        }
        sessionActiveGenerationConfirmations.delete(sessionId)
      }
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/routes/sessions.ts apps/agent-orchestrator/src/routes/sessions.test.ts apps/agent-orchestrator/src/routes/chat.ts
git commit -m "feat(agent-orchestrator): add generation-confirm decision route and stream-cancel cleanup"
```

---

### Task 8: Wire the four tools + DECLINED refusal reason + agent instructions

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/editImage.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateSong.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/producerAgent.ts`
- Test: extend `generateImage.test.ts`, `editImage.test.ts` (if it exists — check), `generateSong.test.ts`, `generateVideo.test.ts`

**Interfaces:**
- Consumes: `confirmGenerationOrDecline` from `./confirmGeneration.js` (Task 6).

- [ ] **Step 1: Write the failing test for generateImage.ts**

Read `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts` first to match its exact mocking pattern (`vi.hoisted`, `vi.mock('@serverless-saas/credits', ...)`). Add a new mock for `confirmGeneration.js` and one new test:

```ts
// Add to the vi.hoisted block:
const { confirmGenerationOrDecline } = vi.hoisted(() => ({
  confirmGenerationOrDecline: vi.fn(),
}))
vi.mock('./confirmGeneration.js', () => ({ confirmGenerationOrDecline }))

// In beforeEach, alongside the existing isUnlimited/resolveRate defaults:
confirmGenerationOrDecline.mockResolvedValue({ confirmed: true })

// New test:
it('short-circuits with DECLINED and never calls the gateway when the user declines', async () => {
  confirmGenerationOrDecline.mockResolvedValue({ confirmed: false })
  const fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch

  const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

  expect(fetchMock).not.toHaveBeenCalled()
  expect(spendCredits).not.toHaveBeenCalled()
  expect(result).toEqual({ refused: true, refusalReason: 'DECLINED' })
})
```

Also add an assertion to the existing success-path test confirming `confirmGenerationOrDecline` was called with the right arguments:

```ts
expect(confirmGenerationOrDecline).toHaveBeenCalledWith(expect.anything(), 'image_generation', 'gemini-3-pro-image-preview', 'Generate image')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateImage.test.ts`
Expected: FAIL — `confirmGenerationOrDecline` is never called by the current implementation, and the new DECLINED test finds `fetchMock` was never even reached (or the mock import fails).

- [ ] **Step 3: Wire generateImage.ts**

In `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`, add the import and the gate call at the top of `execute()`, right after the existing `requestContext.get` lines and before the `let genResult` declaration:

```ts
import { confirmGenerationOrDecline } from './confirmGeneration.js'
```

```ts
    const confirm = await confirmGenerationOrDecline(execContext, 'image_generation', IMAGE_MODEL, 'Generate image')
    if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateImage.test.ts`
Expected: PASS

- [ ] **Step 5: Wire editImage.ts (test first, then implementation)**

`editImage.test.ts` already exists with this exact `vi.hoisted` shape:

```ts
const { spendCredits, resolveRate, isUnlimited, getPool, resolveSourceImage } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(), resolveSourceImage: vi.fn(),
}))
```

Add a second hoisted mock block and register it, following the same pattern as Step 1:

```ts
const { confirmGenerationOrDecline } = vi.hoisted(() => ({
  confirmGenerationOrDecline: vi.fn(),
}))
vi.mock('./confirmGeneration.js', () => ({ confirmGenerationOrDecline }))
```

In `beforeEach`, alongside the existing default mocks: `confirmGenerationOrDecline.mockResolvedValue({ confirmed: true })`. Add:

```ts
it('short-circuits with DECLINED and never resolves the source image when the user declines', async () => {
  confirmGenerationOrDecline.mockResolvedValue({ confirmed: false })
  const fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch

  const result = await editImage.execute!({ prompt: 'make it blue', sourceFileId: 'f1', sourceMimeType: 'image/png' } as never, baseCtx())

  expect(resolveSourceImage).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(spendCredits).not.toHaveBeenCalled()
  expect(result).toEqual({ refused: true, refusalReason: 'DECLINED' })
})
```

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/editImage.test.ts` — expect FAIL (module not mocked/called yet).

Implement in `editImage.ts`: add `import { confirmGenerationOrDecline } from './confirmGeneration.js'`, and — the gate fires **before** `resolveSourceImage`, not after, since resolving a source image is wasted work if the user is about to decline — insert at the very top of `execute()`, before the existing `const source = await resolveSourceImage(...)` line:

```ts
    const confirm = await confirmGenerationOrDecline(execContext, 'image_generation', IMAGE_MODEL, 'Edit image')
    if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }

    const source = await resolveSourceImage(idToken ?? '', sourceFileId, sourceMimeType, sessionId)
```

Run the test again — expect PASS.

- [ ] **Step 6: Wire generateSong.ts (test first, then implementation)**

`generateSong.test.ts` uses this `vi.hoisted` shape:

```ts
const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(),
}))
```

Add the same `confirmGenerationOrDecline` mock block as Step 5, and this test:

```ts
it('short-circuits with DECLINED and never calls the gateway when the user declines', async () => {
  confirmGenerationOrDecline.mockResolvedValue({ confirmed: false })
  const fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch

  const result = await generateSong.execute!({ prompt: 'a calm lo-fi beat' } as never, baseCtx())

  expect(fetchMock).not.toHaveBeenCalled()
  expect(spendCredits).not.toHaveBeenCalled()
  expect(result).toEqual({ refused: true, refusalReason: 'DECLINED' })
})
```

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateSong.test.ts` — expect FAIL.

Implement in `generateSong.ts`: add the import, insert at the top of `execute()`, before the existing gateway `fetch`:

```ts
    const confirm = await confirmGenerationOrDecline(execContext, 'music_generation', MUSIC_MODEL, 'Generate song')
    if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }
```

Run again — expect PASS.

- [ ] **Step 7: Wire generateVideo.ts (test first, then implementation)**

`generateVideo.test.ts` uses the same `vi.hoisted` shape as `generateSong.test.ts` (`spendCredits, resolveRate, isUnlimited, getPool`). Add the same `confirmGenerationOrDecline` mock block, and this test:

```ts
it('short-circuits with DECLINED and never calls the gateway when the user declines', async () => {
  confirmGenerationOrDecline.mockResolvedValue({ confirmed: false })
  const fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch

  const result = await generateVideo.execute!({ prompt: 'a marble rolling down a track' } as never, baseCtx())

  expect(fetchMock).not.toHaveBeenCalled()
  expect(spendCredits).not.toHaveBeenCalled()
  expect(result).toEqual({ refused: true, refusalReason: 'DECLINED' })
})
```

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateVideo.test.ts` — expect FAIL.

Implement in `generateVideo.ts`: add the import, insert at the top of `execute()`, before the existing gateway `fetch`:

```ts
    const confirm = await confirmGenerationOrDecline(execContext, 'video_generation', VIDEO_MODEL, 'Generate video')
    if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }
```

Run again — expect PASS.

- [ ] **Step 8: Update Director's instructions**

In `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`, the image-rules block's refusal-handling bullets currently list `STORAGE_FAILED`/`SAFETY`/`SOURCE_IMAGE_*` with no catch-all. Add a new bullet immediately after the existing refusalReason list (both the image rules section and the video rules section each need this — check both blocks in the file):

```
  - "DECLINED": the user chose not to proceed when asked to confirm the cost. Say so plainly and do not retry or re-ask in the same turn.
```

- [ ] **Step 9: Update Producer's instructions**

In `apps/agent-orchestrator/src/mastra/agents/producerAgent.ts`, add the same bullet to its refusal-handling list:

```
  - "DECLINED": the user chose not to proceed when asked to confirm the cost. Say so plainly and do not retry or re-ask in the same turn.
```

- [ ] **Step 10: Run the full tool test suite**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/`
Expected: PASS, no regressions in any of the four tools' existing test cases.

- [ ] **Step 11: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts \
        apps/agent-orchestrator/src/mastra/tools/editImage.ts apps/agent-orchestrator/src/mastra/tools/editImage.test.ts \
        apps/agent-orchestrator/src/mastra/tools/generateSong.ts apps/agent-orchestrator/src/mastra/tools/generateSong.test.ts \
        apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts \
        apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/agents/producerAgent.ts
git commit -m "feat(agent-orchestrator): wire generation confirm gate into all four generation tools"
```

---

### Task 9: Frontend types + useChat.ts wiring

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts`
- Modify: `apps/web/hooks/useChat.ts`

**Interfaces:**
- Produces: `GenerationConfirmRequest` interface (frontend), `onGenerationConfirmRequired` callback option, `sendGenerationConfirm(confirmationId, decision)` function — consumed by Task 10.

- [ ] **Step 1: Add the frontend type**

In `apps/web/components/platform/chat/types.ts`, after the existing `ApprovalRequest` interface (around line 23), add:

```ts
export interface GenerationConfirmRequest {
    id: string;
    resourceType: string;
    subject: string;
    label: string;
    status: 'pending' | 'approved' | 'declined';
    decisionAt?: string;
}
```

Find the `Message` interface in this same file (search for where `approvalRequest?: ApprovalRequest` is declared on it) and add alongside it:

```ts
    generationConfirmRequest?: GenerationConfirmRequest;
```

- [ ] **Step 2: Wire useChat.ts's SSE event handling**

In `apps/web/hooks/useChat.ts`:

Add to the `UseChatOptions` interface (near `onApprovalRequired`):

```ts
    onGenerationConfirmRequired?: (confirmationId: string, resourceType: string, subject: string, label: string) => void;
```

Add to the `UseChatReturn` interface (near `sendApproval`):

```ts
    sendGenerationConfirm: (confirmationId: string, decision: 'approved' | 'declined') => Promise<boolean>;
```

Destructure the new option alongside the existing ones (near line 51-52):

```ts
        onGenerationConfirmRequired,
```

Add the ref alongside the existing `onApprovalRequiredRef` (near line 74-75):

```ts
    const onGenerationConfirmRequiredRef = useRef(onGenerationConfirmRequired);
```

Keep it in sync alongside the other refs (near line 89-90):

```ts
    onGenerationConfirmRequiredRef.current = onGenerationConfirmRequired;
```

Add the new SSE case in the event switch, right after the existing `case 'approval_request':` block (around line 336):

```ts
                        case 'generation_confirm_request': {
                            onGenerationConfirmRequiredRef.current?.(
                                payload.confirmationId as string,
                                payload.resourceType as string,
                                payload.subject as string,
                                payload.label as string,
                            );
                            break;
                        }
```

Add `sendGenerationConfirm`, mirroring `sendApproval` exactly (right after it, around line 405):

```ts
    const sendGenerationConfirm = useCallback(async (
        confirmationId: string,
        decision: 'approved' | 'declined',
    ): Promise<boolean> => {
        const { accessToken } = getAuthTokens();
        if (!accessToken) return false;

        try {
            const res = await fetch(`${CHAT_ENDPOINT}/generation-confirm`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ confirmationId, decision }),
            });
            return res.ok;
        } catch {
            return false;
        }
    }, []);
```

Add it to the returned object (near line 437-...):

```ts
        sendGenerationConfirm,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/web && pnpm exec tsc --noEmit` (or whatever this repo's exact type-check script is — check `apps/web/package.json`'s `scripts` first)
Expected: no new errors in `useChat.ts`/`types.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/hooks/useChat.ts
git commit -m "feat(web): add generation confirm request type and useChat wiring"
```

---

### Task 10: Frontend overlay wiring — useChatStream.ts, MessageThread.tsx, page.tsx

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`
- Modify: `apps/web/components/platform/chat/MessageThread.tsx`
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`

**Interfaces:**
- Consumes: `GenerationConfirmRequest` from `../../components/platform/chat/types.js` (Task 9); `sendGenerationConfirm`, `onGenerationConfirmRequired` from `useChat` (Task 9); `ApproveCost` from `@/components/platform/credits/ApproveCost` (already shipped, unmodified).

- [ ] **Step 1: Add the onGenerationConfirmRequired handler to useChatStream.ts**

In `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`, add a new `useCallback` in the `useChat({...})` options object, right after the existing `onApprovalRequired` callback (around line 292-297):

```ts
        onGenerationConfirmRequired: useCallback((confirmationId: string, resourceType: string, subject: string, label: string) => {
            emitStreamEvent('generation_confirm_request');
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const msg: Message = {
                    id: crypto.randomUUID(),
                    conversationId: conversationIdRef.current!,
                    role: 'assistant',
                    content: '',
                    createdAt: new Date().toISOString(),
                    generationConfirmRequest: { id: confirmationId, resourceType, subject, label, status: 'pending' },
                };
                return old ? { data: [...old.data, msg] } : { data: [msg] };
            });
        }, [queryClient]),
```

Find where `sendMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying` are destructured from `useChat({...})` (around line 85) and add `sendGenerationConfirm` to that list. Find the hook's own return statement (around line 407) and add `sendGenerationConfirm` to it too, so `page.tsx` can consume it the same way it already consumes `sendApproval`.

- [ ] **Step 2: Add the composer-hiding condition in page.tsx**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`, right after the existing `awaitingClarificationReply` derivation (line 129):

```ts
    const awaitingGenerationConfirmReply = messages[messages.length - 1]?.generationConfirmRequest?.status === 'pending';
```

Find where `sendApproval` is destructured from `stream` (line 104) and add `sendGenerationConfirm` to that destructuring.

Find the composer's existing `{!awaitingClarificationReply && (` guard (line 328) and widen it:

```tsx
{!awaitingClarificationReply && !awaitingGenerationConfirmReply && (
```

Add `handleGenerationConfirm`/`handleGenerationDecline` handlers, mirroring `handleApprove`/`handleDismiss` (find those around line 190-201) exactly:

```ts
    const handleGenerationConfirm = useCallback(async (confirmationId: string) => {
        const ok = await sendGenerationConfirm(confirmationId, 'approved');
        if (ok) {
            queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old => {
                if (!old) return old;
                return { data: old.data.map(m => m.generationConfirmRequest?.id === confirmationId
                    ? { ...m, generationConfirmRequest: { ...m.generationConfirmRequest!, status: 'approved' as const } }
                    : m) };
            });
        }
    }, [conversationId, queryClient, sendGenerationConfirm]);

    const handleGenerationDecline = useCallback(async (confirmationId: string) => {
        const ok = await sendGenerationConfirm(confirmationId, 'declined');
        if (ok) {
            queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old => {
                if (!old) return old;
                return { data: old.data.map(m => m.generationConfirmRequest?.id === confirmationId
                    ? { ...m, generationConfirmRequest: { ...m.generationConfirmRequest!, status: 'declined' as const } }
                    : m) };
            });
        }
    }, [conversationId, queryClient, sendGenerationConfirm]);
```

(Check the exact `handleApprove`/`handleDismiss` implementation at lines 190-201 first and match its precise `queryClient.setQueryData` shape — the code above is illustrative of the pattern, not a guaranteed byte-for-byte match to what's already there.)

Pass the new handlers into `MessageThread`, alongside the existing `onApprove={handleApprove} onDismiss={handleDismiss}` (line 326):

```tsx
onGenerationConfirm={handleGenerationConfirm} onGenerationDecline={handleGenerationDecline}
```

- [ ] **Step 3: Render the overlay in MessageThread.tsx**

In `apps/web/components/platform/chat/MessageThread.tsx`:

Add the import:

```tsx
import { ApproveCost } from '@/components/platform/credits/ApproveCost';
```

Add new props to the component's prop type (find where `onApprove`/`onDismiss`/`onClarificationAnswer` are declared, near the top of the file):

```ts
    onGenerationConfirm?: (confirmationId: string) => void;
    onGenerationDecline?: (confirmationId: string) => void;
```

Add the derived pending-message value alongside the existing `pendingClarificationMessage` (near line 76):

```ts
    const pendingGenerationConfirmMessage = lastMessage?.generationConfirmRequest?.status === 'pending' ? lastMessage : undefined;
```

Add the overlay render, right after the existing `{pendingClarificationMessage && (...)}` block (after line ~370), following the exact same "anchored toward the bottom" wrapper pattern:

```tsx
        {pendingGenerationConfirmMessage && (
            <div className="absolute inset-0 z-40 flex items-end justify-center pb-6 bg-background/90 backdrop-blur-sm px-4">
                <div className="border border-border rounded-xl overflow-hidden bg-card shadow-card max-w-md w-full">
                    <div className="px-4 py-3 border-b border-border bg-muted/30">
                        <h4 className="text-sm font-semibold">{pendingGenerationConfirmMessage.generationConfirmRequest!.label}</h4>
                    </div>
                    <ApproveCost
                        resourceType={pendingGenerationConfirmMessage.generationConfirmRequest!.resourceType as never}
                        subject={pendingGenerationConfirmMessage.generationConfirmRequest!.subject}
                        onApprove={() => onGenerationConfirm?.(pendingGenerationConfirmMessage.generationConfirmRequest!.id)}
                        onCancel={() => onGenerationDecline?.(pendingGenerationConfirmMessage.generationConfirmRequest!.id)}
                    />
                </div>
            </div>
        )}
```

(The `as never` cast on `resourceType` is because `GenerationConfirmRequest.resourceType` is a plain `string` while `ApproveCost` wants the narrower `CreditResourceType` — Task 1 widened that union to include the three generation types, but the wire-format type carrying it over SSE is intentionally the wider `string` since it's a JSON payload, not a compile-time-checked value. Confirm this cast is actually necessary once Task 1 and Task 9's types are both in place — a cleaner option is narrowing `GenerationConfirmRequest.resourceType`'s type directly, if that doesn't fight the JSON payload's runtime shape.)

- [ ] **Step 4: Verify it compiles and renders**

Run: `cd apps/web && pnpm exec tsc --noEmit` (or the repo's actual type-check script).
Expected: no new errors.

Start the dev server (`pnpm dev` in `apps/web`, or however this repo's `run` skill starts it) and manually trigger a generation in a dev conversation to confirm the overlay actually renders, shows a real cost/balance, and both Confirm and Cancel work end-to-end — this is a UI change, verify it visually per this repo's UI-change convention, not just via `tsc`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/\[tenant\]/dashboard/chat/useChatStream.ts apps/web/app/\[tenant\]/dashboard/chat/page.tsx apps/web/components/platform/chat/MessageThread.tsx
git commit -m "feat(web): render generation confirm overlay, hide composer while pending"
```

---

### Task 11: Manual deployment and verification (operational, not code)

- [ ] **Step 1: Deploy the Lambda** (schema + messages.ts changes)

```bash
pnpm --filter @serverless-saas/database build
pnpm --filter @serverless-saas/agent-* build
sam build --config-file samconfig.dev.toml
sam deploy --config-file samconfig.dev.toml
```

- [ ] **Step 2: Restart the orchestrator**

```bash
pm2 restart agent-orchestrator
```

- [ ] **Step 3: Deploy the web app**

```bash
./deploy.sh
```

- [ ] **Step 4: Manual smoke test**

In dev, ask Director for an image. Confirm the overlay appears with a real cost and balance figure, the composer is hidden while it's up, Confirm proceeds to generate and charges correctly, and a fresh request followed by Cancel produces no charge and a plain "declined" message from the agent with no retry. Repeat once for Producer's song generation. Confirm an unlimited tenant sees no overlay at all. Close the tab mid-confirm on a throwaway request and verify (via logs) the pending confirmation resolves to declined promptly rather than sitting for the full 5 minutes.
