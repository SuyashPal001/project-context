# Agent Personas — 9-State Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the merged Agent Personas feature's animation model from 3 states (`idle | thinking | responding`) to 9 (`idle | waving | running | thinking | responding | waiting | review | done | failed`), each driven by a real signal already present in the chat pipeline, and finally wire the animation-state hook into the UI (it currently exists but is never consumed anywhere — every persona renders permanently pinned to `idle`).

**Architecture:** Extend the `PersonaAnimationStates` type (frontend + backend) and the ops publish-gate to require all 9 keys. Extend the pure reducer with `approval_request` (a real, already-wired SSE event — see Global Constraints) and `artifact_ready` (a synthetic event derived from `Message.artifactRef`). Add a `waving` short-circuit at the render layer for empty conversations. Track the most recent raw SSE event inside `useChatStream.ts` (already implements every callback that would set it). This app only ever has one conversation actively streaming at a time (a single `useChatStream` instance scoped to whichever conversation is currently open), so "drive `ConversationList`'s agent avatars from their most recently active conversation" collapses to: compute the live animation state once, centrally, in `page.tsx`, and pass it to both `ChatHeader` (the open conversation's header) and `ConversationList` (which applies it only to the `AgentSection` matching the currently open conversation's agent — every other agent section has no live stream right now and keeps rendering its existing idle/fallback state).

**Tech Stack:** TypeScript, React (Next.js `apps/web`), Drizzle ORM/Postgres (`products/agent-platform/packages/schema`, `packages/api`), Hono, Vitest.

## Global Constraints

- No SSE protocol changes on the orchestrator side — `approval_request` already exists as a real wire event (`apps/agent-orchestrator/src/routes/sessions.ts:47-48`, forwarded through `chat.ts:165`'s `sseApprovalChannels`); this plan only adds a frontend consumer for it. `artifact_ready` is the one synthetic event, derived client-side from `Message.artifactRef`, never sent over the wire. (Design spec, Non-goals + §2.)
- **`waiting` derives from the real `approval_request` SSE event, not from `Message.artifactRef.pmRunId`/`pmStepId`.** Two earlier drafts of the design spec got this wrong — first assuming `Message.approvalRequest` was dead (it isn't: `useChatStream.ts:162-167` populates it client-side from every real `approval_request` event), then wrongly substituting the PM-workflow's separate Mastra HITL resumption gate. The full traced chain lives in the design spec §2; this plan implements the corrected version only.
- `review` derives from `Message.artifactRef` being present on the latest assistant message — no disambiguation needed, since `waiting` is independently covered by the real `approval_request` event.
- `run left`, `run right`, `jumping` are explicitly not being built — no product signal maps to them. (Design spec, Non-goals.)
- `done`/`failed` auto-decay to `idle` after exactly 2.5 seconds, implemented as a `setTimeout` in the component consuming the hook (`page.tsx`, which computes `displayState` centrally so both `ChatHeader` and `ConversationList` can share it — see Task 5), never inside the pure reducer. (Design spec §2.)
- The reducer must stay a pure, side-effect-free function testable exactly like the existing one — no `setTimeout`/timers/async logic inside `reducePersonaAnimationState` itself.
- `PersonaAvatar.tsx`'s own rendering logic does not need to change — it already reads `persona?.animationStates?.[state] ?? persona?.animationStates?.idle` generically for any state key. (Design spec §3.)
- `ConversationList.tsx` **is** in scope this round — the live state is computed once in `page.tsx` and applied to whichever `AgentSection` matches the currently open conversation's agent; every other agent section is unaffected (no live stream exists for a conversation that isn't the one currently open).

---

## File Structure

Modified files:
- `products/agent-platform/packages/schema/personas.ts` — `PersonaAnimationStates` type grows from 3 to 9 keys
- `products/agent-platform/packages/api/routes/personas.ts` — `animationStatesSchema` (Zod) grows to 9 keys; publish-gate checks all 9
- `products/agent-platform/packages/api/__tests__/personas.test.ts` — extend the publish-gate test for the 9-key requirement
- `apps/web/components/platform/personas/types.ts` — `PersonaAnimationStates` interface grows to 9 keys
- `apps/web/components/platform/personas/usePersonaAnimationState.ts` — reducer gains `approval_request`/`artifact_ready` cases, `running` becomes its own state (was folded into `thinking`), `done`/`failed` become their own states (were folded into `idle`)
- `apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts` — new test cases for every added transition
- `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts` — adds a `lastStreamEvent` piece of state, set inside the 6 existing callbacks (`onDelta`, `onToolCall`, `onToolDone`, `onDone`, `onError`, `onApprovalRequired`) without altering their existing bodies; returned from the hook
- `apps/web/app/[tenant]/dashboard/chat/page.tsx` — becomes the single owner of the animation-state computation: uses `usePersonaAnimationState`, forwards `lastStreamEvent`, derives `artifact_ready` from `messages`, applies the `waving` short-circuit and the 2.5s decay timer, then passes the resulting `displayState` to `ChatHeader` and (`displayState` + the currently-open conversation's `agentId`) to `ConversationList`
- `apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx` — simplified to a pure consumer: accepts a `state` prop directly (no hook logic of its own), passes it to `PersonaAvatar`
- `apps/web/components/platform/chat/ConversationList.tsx` — `ConversationListProps` and `AgentSection`'s props gain `activeAgentId`/`activeState`; the active-agents `AgentSection` map passes `state={agent.id === activeAgentId ? activeState : undefined}` to `PersonaAvatar`

No new files — this is entirely an extension of existing, already-reviewed code.

---

### Task 1: Extend `PersonaAnimationStates` to 9 keys (schema + API validation)

**Files:**
- Modify: `products/agent-platform/packages/schema/personas.ts:8-12`
- Modify: `products/agent-platform/packages/api/routes/personas.ts:11-15,116-118`
- Modify: `products/agent-platform/packages/api/__tests__/personas.test.ts`

**Interfaces:**
- Consumes: nothing new — `personas.animation_states` is already a `jsonb` column, no migration needed for a type-only change.
- Produces: `PersonaAnimationStates` type with 9 required string keys, consumed by Task 2 (frontend types) and Task 3 (reducer).

- [ ] **Step 1: Update the backend type**

In `products/agent-platform/packages/schema/personas.ts`, replace:

```typescript
export type PersonaAnimationStates = {
  idle: string;
  thinking: string;
  responding: string;
};
```

with:

```typescript
export type PersonaAnimationStates = {
  idle: string;
  waving: string;
  running: string;
  thinking: string;
  responding: string;
  waiting: string;
  review: string;
  done: string;
  failed: string;
};
```

Nothing else in this file changes — `animationStates: jsonb('animation_states').$type<PersonaAnimationStates | null>()` picks up the new shape automatically since it's a TypeScript-level type parameter, not a DB constraint.

- [ ] **Step 2: Update the Zod validation schema in the ops route**

In `products/agent-platform/packages/api/routes/personas.ts`, replace:

```typescript
const animationStatesSchema = z.object({
    idle: z.string().url(),
    thinking: z.string().url(),
    responding: z.string().url(),
});
```

with:

```typescript
const animationStatesSchema = z.object({
    idle: z.string().url(),
    waving: z.string().url(),
    running: z.string().url(),
    thinking: z.string().url(),
    responding: z.string().url(),
    waiting: z.string().url(),
    review: z.string().url(),
    done: z.string().url(),
    failed: z.string().url(),
});
```

This schema is referenced by both `POST /` and `PUT /:id` via `animationStatesSchema.optional()` — no other change needed at those two call sites.

- [ ] **Step 3: Update the publish-gate to require all 9 keys**

In `products/agent-platform/packages/api/routes/personas.ts`, replace the `POST /:id/publish` handler's gate check:

```typescript
    const states = existing.animationStates;
    if (!states || !states.idle || !states.thinking || !states.responding) {
        return c.json({ error: 'Persona needs idle, thinking, and responding assets before publishing', code: 'INCOMPLETE_ASSETS' }, 409);
    }
```

with:

```typescript
    const states = existing.animationStates;
    const requiredStates = ['idle', 'waving', 'running', 'thinking', 'responding', 'waiting', 'review', 'done', 'failed'] as const;
    const missing = requiredStates.filter((key) => !states?.[key]);
    if (missing.length > 0) {
        return c.json({ error: `Persona is missing animation states: ${missing.join(', ')}`, code: 'INCOMPLETE_ASSETS' }, 409);
    }
```

- [ ] **Step 4: Update the existing publish-gate test and add two new ones**

In `products/agent-platform/packages/api/__tests__/personas.test.ts`, the existing test `'rejects publishing a persona missing animation states'` continues to pass unchanged (`animationStates: null` still fails the new gate — `states?.[key]` is `undefined` for every key). Add two more tests directly after it, inside the same `describe('personasRoutes publish', ...)` block:

```typescript
    it('rejects publishing a persona with only the old 3-state set (idle/thinking/responding)', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{
                        id: 'p1',
                        animationStates: {
                            idle: 'https://example.com/idle.png',
                            thinking: 'https://example.com/thinking.png',
                            responding: 'https://example.com/responding.png',
                        },
                    }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('INCOMPLETE_ASSETS');
        expect(body.error).toContain('waving');
    });

    it('allows publishing a persona with all 9 animation states present', async () => {
        const allStates = {
            idle: 'https://example.com/idle.png',
            waving: 'https://example.com/waving.png',
            running: 'https://example.com/running.png',
            thinking: 'https://example.com/thinking.png',
            responding: 'https://example.com/responding.png',
            waiting: 'https://example.com/waiting.png',
            review: 'https://example.com/review.png',
            done: 'https://example.com/done.png',
            failed: 'https://example.com/failed.png',
        };
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', animationStates: allStates, status: 'draft' }],
                }),
            }),
        });
        dbMock.update.mockReturnValue({
            set: () => ({
                where: () => ({
                    returning: async () => [{ id: 'p1', status: 'published', animationStates: allStates }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.persona.status).toBe('published');
    });
```

- [ ] **Step 5: Rebuild the schema package and run the backend test suite**

Run:
```bash
pnpm --filter @serverless-saas/agent-schema build
pnpm --filter @serverless-saas/agent-api test
```
Expected: schema build succeeds with no errors; test suite passes (baseline before this task: 26 files / 195 tests — expect 26 files / 197 tests after).

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/schema/personas.ts \
        products/agent-platform/packages/api/routes/personas.ts \
        products/agent-platform/packages/api/__tests__/personas.test.ts
git commit -m "feat(schema,api): extend persona animationStates to 9 states"
```

---

### Task 2: Extend the frontend `PersonaAnimationStates` type

**Files:**
- Modify: `apps/web/components/platform/personas/types.ts:1-5`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PersonaAnimationStates` interface with 9 required string keys, matching Task 1's backend type exactly. Consumed by Task 3 (reducer); already consumed structurally by `PersonaAvatar.tsx` with no change needed there.

- [ ] **Step 1: Update the interface**

In `apps/web/components/platform/personas/types.ts`, replace:

```typescript
export interface PersonaAnimationStates {
    idle: string;
    thinking: string;
    responding: string;
}
```

with:

```typescript
export interface PersonaAnimationStates {
    idle: string;
    waving: string;
    running: string;
    thinking: string;
    responding: string;
    waiting: string;
    review: string;
    done: string;
    failed: string;
}
```

Nothing else in this file changes.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter web type-check`

Expected: this surfaces every place that constructs or reads a `PersonaAnimationStates` value assuming only 3 keys. At this point the only such place is `usePersonaAnimationState.ts`'s `PersonaAnimationState` union (Task 3 fixes it). Confirm no other new errors appear. Known pre-existing unrelated errors remain in `app/auth/invite/[token]/page.tsx` and `app/auth/login/page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/platform/personas/types.ts
git commit -m "feat(web): extend PersonaAnimationStates type to 9 states"
```

---

### Task 3: Extend the reducer with the 6 new states and the `approval_request`/`artifact_ready` events

**Files:**
- Modify: `apps/web/components/platform/personas/usePersonaAnimationState.ts`
- Modify: `apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts`

**Interfaces:**
- Consumes: `PersonaAnimationStates` (Task 2) — indirectly, via the state-name union staying in sync with the type's keys.
- Produces: `PersonaAnimationState` union of 9 values; `ChatStreamEventType` union of 7 values (`tool_call`, `tool_done`, `delta`, `done`, `error` — the existing 5 real SSE names — plus `approval_request`, also a real SSE event name, plus `artifact_ready`, the one synthetic event). `reducePersonaAnimationState(current, event)` handling all 7 cases. `usePersonaAnimationState()` unchanged in shape (`{ state, onStreamEvent }`).

- [ ] **Step 1: Write the new failing tests first**

Replace the full contents of `apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { reducePersonaAnimationState } from "../usePersonaAnimationState";

describe("reducePersonaAnimationState", () => {
    it("starts idle and moves to running on tool_call", () => {
        expect(reducePersonaAnimationState("idle", "tool_call")).toBe("running");
    });

    it("moves to thinking on tool_done", () => {
        expect(reducePersonaAnimationState("running", "tool_done")).toBe("thinking");
    });

    it("moves to responding on delta", () => {
        expect(reducePersonaAnimationState("thinking", "delta")).toBe("responding");
    });

    it("moves to waiting on approval_request", () => {
        expect(reducePersonaAnimationState("responding", "approval_request")).toBe("waiting");
    });

    it("moves to review on artifact_ready", () => {
        expect(reducePersonaAnimationState("responding", "artifact_ready")).toBe("review");
    });

    it("moves to done on done", () => {
        expect(reducePersonaAnimationState("responding", "done")).toBe("done");
    });

    it("moves to failed on error", () => {
        expect(reducePersonaAnimationState("thinking", "error")).toBe("failed");
    });

    it("returns the current state for an unrecognized event", () => {
        // @ts-expect-error — exercising the default branch with a value outside ChatStreamEventType
        expect(reducePersonaAnimationState("idle", "unknown_event")).toBe("idle");
    });
});
```

Note: `waving` has no reducer test here — per the design spec, `waving` is not a reducer case at all (it's a render-layer decision made in Task 4 before the reducer is ever invoked), so it has no transition to test in this file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test usePersonaAnimationState`
Expected: FAIL — `reducePersonaAnimationState("idle", "tool_call")` currently returns `"thinking"`, not `"running"`; `"approval_request"` and `"artifact_ready"` aren't valid `ChatStreamEventType` values yet; `"done"`/`"error"` currently return `"idle"`, not `"done"`/`"failed"`.

- [ ] **Step 3: Rewrite the reducer**

Replace the full contents of `apps/web/components/platform/personas/usePersonaAnimationState.ts` with:

```typescript
import { useReducer } from "react";

export type PersonaAnimationState =
    | "idle" | "waving" | "running" | "thinking" | "responding"
    | "waiting" | "review" | "done" | "failed";

export type ChatStreamEventType =
    | "tool_call" | "tool_done" | "delta" | "done" | "error"
    | "approval_request" | "artifact_ready";

export function reducePersonaAnimationState(
    _current: PersonaAnimationState,
    event: ChatStreamEventType,
): PersonaAnimationState {
    switch (event) {
        case "tool_call":
            return "running";
        case "tool_done":
            return "thinking";
        case "delta":
            return "responding";
        case "approval_request":
            return "waiting";
        case "artifact_ready":
            return "review";
        case "done":
            return "done";
        case "error":
            return "failed";
        default:
            return _current;
    }
}

export function usePersonaAnimationState() {
    const [state, dispatch] = useReducer(reducePersonaAnimationState, "idle");
    return { state, onStreamEvent: dispatch };
}
```

`approval_request` is the real SSE event name used on the wire (`apps/agent-orchestrator/src/routes/sessions.ts:48`, forwarded via `chat.ts:165`) — Task 5's consumer (`page.tsx`) forwards it directly, the same way it forwards `tool_call`/`delta`/etc. `artifact_ready` has no wire event by that name; Task 5's consumer derives and dispatches it after inspecting `Message.artifactRef`. This file has no knowledge of `Message`/SSE wiring at all — that logic belongs entirely in Task 5, keeping this reducer a pure, dependency-free function exactly as before.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test usePersonaAnimationState`
Expected: PASS, all 8 cases.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter web type-check`
Expected: the `PersonaAnimationState`/`PersonaAnimationStates` mismatch noted in Task 2 Step 2 is now gone. Only the known pre-existing unrelated auth-page errors remain.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/personas/usePersonaAnimationState.ts \
        apps/web/components/platform/personas/__tests__/usePersonaAnimationState.test.ts
git commit -m "feat(web): expand persona animation reducer to 9 states"
```

---

### Task 4: Track `lastStreamEvent` in `useChatStream.ts` and thread it through `page.tsx`

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`

**Interfaces:**
- Consumes: `ChatStreamEventType` (Task 3) for the state's type.
- Produces: `useChatStream(...)` return value gains `lastStreamEvent: ChatStreamEventType | null`. `page.tsx` passes `stream.lastStreamEvent` and the existing `messages` variable to `<ChatHeader>` (Task 5 consumes both).

`useChatStream.ts` already implements every callback (`onDelta`, `onToolCall`, `onToolDone`, `onDone`, `onError`, `onApprovalRequired`) that corresponds to a real SSE event — this task adds one line to each, recording which event most recently fired, without changing any of their existing logic.

- [ ] **Step 1: Add the `lastStreamEvent` state and import the type**

In `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`, add the import:

```typescript
import type { ChatStreamEventType } from '@/components/platform/personas/usePersonaAnimationState';
```

Inside the `useChatStream` function body, add a new state declaration alongside the existing ones (near `const [eventError, setEventError] = useState<string | null>(null);`):

```typescript
    const [lastStreamEvent, setLastStreamEvent] = useState<ChatStreamEventType | null>(null);
```

- [ ] **Step 2: Set it inside each of the 6 existing callbacks**

Add exactly one line — `setLastStreamEvent('<event-name>');` — as the **first** line inside each callback body, before its existing logic. This ordering matters only for readability, not correctness, but keep it first for consistency:

- `onDelta`'s callback body → add `setLastStreamEvent('delta');` as the first line.
- `onDone`'s callback body → add `setLastStreamEvent('done');` as the first line.
- `onError`'s callback body → add `setLastStreamEvent('error');` as the first line.
- `onToolCall`'s callback body → add `setLastStreamEvent('tool_call');` as the first line.
- `onToolDone`'s callback body → add `setLastStreamEvent('tool_done');` as the first line.
- `onApprovalRequired`'s callback body → add `setLastStreamEvent('approval_request');` as the first line.

Do not reorder, remove, or otherwise modify any existing line in these six callbacks — this task is additive only. Each callback already has a `useCallback` dependency array; `setLastStreamEvent` is a stable setter from `useState` and does not need to be added to any dependency array.

- [ ] **Step 3: Return `lastStreamEvent` from the hook**

In the `return` statement at the end of `useChatStream`, add `lastStreamEvent` to the returned object:

```typescript
    return {
        sendMessage, sendApproval, cancel, isStreaming, isRetrying,
        activeToolCalls, completedToolCalls,
        eventError, warmupMessage, agentTimedOut, hasSentFirstMessage,
        lastStreamEvent,
    };
```

- [ ] **Step 4: Destructure and pass it through in `page.tsx`**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`, update the existing destructure:

```typescript
    const { sendMessage, sendApproval, cancel, isStreaming, isRetrying, activeToolCalls, completedToolCalls, eventError, warmupMessage, agentTimedOut, hasSentFirstMessage } = stream;
```

to also pull `lastStreamEvent`:

```typescript
    const { sendMessage, sendApproval, cancel, isStreaming, isRetrying, activeToolCalls, completedToolCalls, eventError, warmupMessage, agentTimedOut, hasSentFirstMessage, lastStreamEvent } = stream;
```

This task stops here — `lastStreamEvent` is now available in `page.tsx`'s scope. Task 5 is what actually consumes it (computing `displayState` centrally in `page.tsx`, per this plan's Architecture section, rather than passing raw `lastStreamEvent`/`messages` down into `ChatHeader` for it to compute internally — that would prevent `ConversationList`, a sibling component, from ever seeing the same computed state).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter web type-check`
Expected: no new errors — `lastStreamEvent` is destructured but not yet used anywhere in this file, which is a harmless unused-variable situation resolved in Task 5, not a type error. Confirm no new errors appear beyond the known pre-existing unrelated ones.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/[tenant]/dashboard/chat/useChatStream.ts \
        apps/web/app/[tenant]/dashboard/chat/page.tsx
git commit -m "feat(web): track lastStreamEvent in useChatStream"
```

---

### Task 5: Compute `displayState` centrally in `page.tsx`; simplify `ChatHeader.tsx` to a pure consumer

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`
- Modify: `apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx`

**Interfaces:**
- Consumes: `usePersonaAnimationState`, `PersonaAnimationState`, `ChatStreamEventType` (Task 3); `lastStreamEvent` (Task 4); `messages` (already in scope in `page.tsx`).
- Produces: a `displayState: PersonaAnimationState` value computed in `page.tsx`, passed to `<ChatHeader state={displayState} />` (this task) and to `<ConversationList activeState={displayState} activeAgentId={...} />` (Task 6). `ChatHeader`'s `Props` gains a plain `state: PersonaAnimationState` field, replacing the `messages`/`lastStreamEvent` props that would otherwise have been needed if `ChatHeader` computed this itself.

- [ ] **Step 1: Add the animation-state computation to `page.tsx`**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`, add to the imports:

```typescript
import { useEffect, useRef, useState } from 'react';
import { usePersonaAnimationState } from '@/components/platform/personas/usePersonaAnimationState';
```

(`useCallback`, `Suspense`, `useState` are already imported from `'react'` in this file per the current merged code — merge `useEffect`, `useRef` into that same existing import statement rather than adding a second one.)

Inside the `ChatPage` component body, after the existing `const { sendMessage, ..., lastStreamEvent } = stream;` line, add:

```typescript
    const { state: animationState, onStreamEvent } = usePersonaAnimationState();
    const [decayedState, setDecayedState] = useState<typeof animationState>('idle');
    const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!lastStreamEvent) return;
        onStreamEvent(lastStreamEvent);
    }, [lastStreamEvent, onStreamEvent]);

    useEffect(() => {
        const latest = messages[messages.length - 1];
        if (latest?.role === 'assistant' && latest.artifactRef) {
            onStreamEvent('artifact_ready');
        }
    }, [messages, onStreamEvent]);

    useEffect(() => {
        if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
        setDecayedState(animationState);
        if (animationState === 'done' || animationState === 'failed') {
            decayTimerRef.current = setTimeout(() => setDecayedState('idle'), 2500);
        }
        return () => {
            if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
        };
    }, [animationState]);

    const isNewConversation = messages.length === 0;
    const displayState = isNewConversation ? 'waving' : decayedState;
```

Three independent effects, identical in behavior to what a `ChatHeader`-local version would have done, just relocated so `ConversationList` (Task 6) can share the same computed value: (1) forward the most recent real SSE event name into the reducer whenever it changes — this already covers `approval_request` since Task 4 set it as one of the six tracked events; (2) inspect the latest assistant message for an `artifactRef` and dispatch the synthetic `artifact_ready` event when present; (3) apply the 2.5s auto-decay purely at the render layer, clearing any prior timer on each new state so a stale decay can't fire after a newer state has already landed.

- [ ] **Step 2: Pass `displayState` to `ChatHeader`**

Update the existing `<ChatHeader ... />` call site to pass `state={displayState}` instead of `messages`/`lastStreamEvent`:

```typescript
                                <ChatHeader
                                    selectedConversation={selectedConversation}
                                    isChatSidebarCollapsed={isChatSidebarCollapsed}
                                    toggleChatSidebar={toggleChatSidebar}
                                    isCanvasOpen={isCanvasOpen}
                                    hasActivity={hasActivity}
                                    toggleCanvas={toggleCanvas}
                                    onArchive={() => setIsDeleteDialogOpen(true)}
                                    state={displayState}
                                />
```

- [ ] **Step 3: Simplify `ChatHeader.tsx` to a pure `state` consumer**

In `apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx`, add the import:

```typescript
import type { PersonaAnimationState } from '@/components/platform/personas/usePersonaAnimationState';
```

Update `Props`:

```typescript
interface Props {
    selectedConversation: Conversation;
    isChatSidebarCollapsed: boolean;
    toggleChatSidebar: () => void;
    isCanvasOpen: boolean;
    hasActivity: boolean;
    toggleCanvas: () => void;
    onArchive: () => void;
    state: PersonaAnimationState;
}
```

Update the function signature to destructure `state`, and pass it straight to `PersonaAvatar` — replace:

```typescript
export function ChatHeader({ selectedConversation, isChatSidebarCollapsed, toggleChatSidebar, isCanvasOpen, hasActivity, toggleCanvas, onArchive }: Props) {
    const title = selectedConversation.title
        || (selectedConversation.agent?.name ? `Chat with ${selectedConversation.agent.name}` : 'Chat with Agent');
```

with:

```typescript
export function ChatHeader({ selectedConversation, isChatSidebarCollapsed, toggleChatSidebar, isCanvasOpen, hasActivity, toggleCanvas, onArchive, state }: Props) {
    const title = selectedConversation.title
        || (selectedConversation.agent?.name ? `Chat with ${selectedConversation.agent.name}` : 'Chat with Agent');
```

and replace:

```typescript
                <PersonaAvatar persona={selectedConversation.agent?.persona} size={40} />
```

with:

```typescript
                <PersonaAvatar persona={selectedConversation.agent?.persona} state={state} size={40} />
```

`ChatHeader.tsx` now has no hook logic, no `useEffect`, no timers of its own — it's a pure prop-driven component exactly as it was before this whole plan, just with one additional prop.

- [ ] **Step 4: Type-check and run the existing test suite**

Run:
```bash
pnpm --filter web type-check
pnpm --filter web test
```
Expected: no new type errors beyond the known pre-existing unrelated ones; existing test suite (16 tests) still passes. This task adds no new automated tests of its own since it's UI wiring against live SSE/message data this codebase has no component-render test harness for (confirmed in the original persona plan's Task 9 — no jsdom/RTL setup exists). Verify by hand-tracing instead, and record the trace in your completion notes: what `displayState` would be for (a) a brand-new empty conversation (`messages.length === 0`) — `waving`; (b) mid-stream right after a `tool_call` SSE event lands — `running`; (c) right after a `tool_done` event — `thinking`; (d) mid-stream during `delta` events — `responding`; (e) right after an `approval_request` event lands — `waiting`; (f) after a `done` event where the latest assistant message carries an `artifactRef` — flag this one explicitly: both the `done` event and the `messages` update (carrying the new `artifactRef`) typically land from the same `onDone` callback in `useChatStream.ts`, so both `useEffect`s in Step 1 fire from the same render pass, and whichever one's `onStreamEvent` call is processed last by React's reducer batching wins the displayed state — trace which one that actually is (React processes effects in the order they're declared within a component for a given commit, so the `artifact_ready` effect, declared second, should win over `done`, declared first — confirm this holds rather than assuming); (g) after a `done` event with no `artifactRef` — `done`, decaying to `idle` after 2.5s; (h) after an `error` event — `failed`, decaying to `idle` after 2.5s.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/[tenant]/dashboard/chat/page.tsx \
        apps/web/app/[tenant]/dashboard/chat/ChatHeader.tsx
git commit -m "feat(web): compute persona displayState centrally in page.tsx"
```

---

### Task 6: Wire `displayState` into `ConversationList.tsx`'s active agent section

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/chat/page.tsx`
- Modify: `apps/web/components/platform/chat/ConversationList.tsx`

**Interfaces:**
- Consumes: `displayState` (Task 5, already computed in `page.tsx`); `PersonaAnimationState` type (Task 3).
- Produces: `ConversationListProps` and `AgentSection`'s prop type gain `activeAgentId?: string` and `activeState?: PersonaAnimationState`. No further tasks depend on this — it's the last consumer.

Since this app only ever has one conversation actively streaming (the currently open one), "drive `ConversationList`'s agent avatars from their most recently active conversation" means: the `AgentSection` whose `agent.id` matches the currently open conversation's agent shows the live `displayState`; every other agent section (no live stream right now) keeps rendering exactly as it does today (defaulting to `idle` inside `PersonaAvatar`, unchanged).

- [ ] **Step 1: Pass `activeAgentId` and `activeState` from `page.tsx` to `ConversationList`**

In `apps/web/app/[tenant]/dashboard/chat/page.tsx`, find the existing `<ConversationList selectedId={conversationId || undefined} onSelect={handleSelectConversation} onNewChat={handleNewChat} />` call site and add the two new props:

```typescript
                    <ConversationList
                        selectedId={conversationId || undefined}
                        onSelect={handleSelectConversation}
                        onNewChat={handleNewChat}
                        activeAgentId={selectedConversation?.agent?.id ?? selectedConversation?.agentId}
                        activeState={displayState}
                    />
```

(`selectedConversation?.agent?.id ?? selectedConversation?.agentId` mirrors the exact expression already used at this file's `useChatStream({ agentId: selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id, ... })` call — reuse the same fallback order for consistency, though note the two existing call sites in this file order the `??` operands differently from each other already; use `agent?.id` first since that's the more authoritative value once a conversation is loaded.)

- [ ] **Step 2: Update `ConversationList.tsx`'s prop types**

In `apps/web/components/platform/chat/ConversationList.tsx`, add the import:

```typescript
import type { PersonaAnimationState } from "@/components/platform/personas/usePersonaAnimationState";
```

Update `ConversationListProps`:

```typescript
interface ConversationListProps {
    selectedId?: string;
    onSelect: (conversation: Conversation) => void;
    onNewChat: (agentId?: string) => void;
    activeAgentId?: string;
    activeState?: PersonaAnimationState;
}
```

Update `AgentSection`'s prop type to accept the same two fields:

```typescript
function AgentSection({ agent, conversations, selectedId, onSelect, onNewChat, onArchive, onDelete, activeAgentId, activeState }: {
    agent: Agent;
    conversations: Conversation[];
    selectedId?: string;
    onSelect: (c: Conversation) => void;
    onNewChat: (agentId: string) => void;
    onArchive: (id: string) => void;
    onDelete: (id: string) => void;
    activeAgentId?: string;
    activeState?: PersonaAnimationState;
}) {
```

- [ ] **Step 3: Apply the state conditionally in `AgentSection`'s `PersonaAvatar`**

Replace the existing `PersonaAvatar` call inside `AgentSection` (the active-agent header, not the locked-agent block further down — locked agents can't be the currently open conversation's agent, so they're untouched by this task):

```typescript
                        <PersonaAvatar
                            persona={agent.persona}
                            size={16}
                            className="rounded bg-transparent border-0"
                            iconClassName="text-muted-foreground/50"
                        />
```

with:

```typescript
                        <PersonaAvatar
                            persona={agent.persona}
                            state={agent.id === activeAgentId ? activeState : undefined}
                            size={16}
                            className="rounded bg-transparent border-0"
                            iconClassName="text-muted-foreground/50"
                        />
```

(`PersonaAvatar`'s `state` prop already defaults to `'idle'` when `undefined` is passed, per its existing implementation — no change needed there.)

- [ ] **Step 4: Update `ConversationList`'s destructure and thread the two new props into the active-agents map**

In the `ConversationList` component body, update the function signature:

```typescript
export function ConversationList({ selectedId, onSelect, onNewChat, activeAgentId, activeState }: ConversationListProps) {
```

Update the `activeAgents.map(agent => (<AgentSection ... />))` call to pass the two new props through:

```typescript
                        {activeAgents.map(agent => (
                            <AgentSection
                                key={agent.id}
                                agent={agent}
                                conversations={convsByAgent[agent.id] ?? []}
                                selectedId={selectedId}
                                onSelect={onSelect}
                                onNewChat={onNewChat}
                                onArchive={(id) => { setActionType('archive'); setDeleteId(id); }}
                                onDelete={(id) => { setActionType('delete'); setDeleteId(id); }}
                                activeAgentId={activeAgentId}
                                activeState={activeState}
                            />
                        ))}
```

The `lockedAgents.map(...)` block further down is untouched — it renders a completely separate, non-`AgentSection` markup block that doesn't take these props.

- [ ] **Step 5: Type-check and run the existing test suite**

Run:
```bash
pnpm --filter web type-check
pnpm --filter web test
```
Expected: no new type errors beyond the known pre-existing unrelated ones; existing test suite (16 tests) still passes. Verify by hand-tracing in your completion notes: with a conversation open for Agent A and a second, different conversation existing (but not open) for Agent B, confirm Agent A's `AgentSection` avatar reflects `displayState` while Agent B's `AgentSection` avatar renders exactly as it did before this task (idle fallback, `state` prop effectively `undefined` since `agent.id !== activeAgentId`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/[tenant]/dashboard/chat/page.tsx \
        apps/web/components/platform/chat/ConversationList.tsx
git commit -m "feat(web): drive ConversationList's active agent avatar from displayState"
```

---

## Follow-up (explicitly not part of this plan)

- Generating the additional 6 animation-state art assets per persona (Higgsfield) — an art/content task, not engineering, same as the original plan's deferred art-sourcing step.
- Confirming and, if needed, fixing the `done` vs. `review` effect-ordering race noted in Task 5 Step 4(f) — flagged for hand-tracing during that task, but if the trace reveals a genuine flicker or wrong-state display, it's a fast follow-up fix (e.g. merging the two effects into one with explicit priority) rather than something to speculatively fix now without evidence.
- If a tenant ever opens multiple browser tabs with different conversations for the same agent simultaneously, `activeAgentId`/`displayState` in `page.tsx` only reflects whichever tab computed them — this is a pre-existing single-page-instance assumption throughout this app's chat architecture (one `useChatStream` per page load), not a regression introduced by this plan, and not addressed here.
