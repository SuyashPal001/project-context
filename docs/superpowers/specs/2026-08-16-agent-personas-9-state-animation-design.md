# Agent Personas — 9-State Animation Design (Addendum)

## Problem

The merged Agent Personas feature (`docs/superpowers/specs/2026-08-16-agent-personas-design.md`,
implemented via `docs/superpowers/plans/2026-08-16-agent-personas.md`) ships a 3-state
animation model — `idle | thinking | responding` — driven by the chat SSE stream. On
review against Petdex's reference UI (a "State Viewer" showing 9 named animation states
per character: idle, run left/right, waving, jumping, failed, waiting, running, review),
the user asked to expand to a comparable state count.

Petdex's own 9 states don't transfer directly: `run left/right` and `jumping` exist for a
floating desktop pet that roams the screen and needs locomotion animations — nothing in a
browser chat UI triggers that. Copying them would add unused art assets with no real
trigger, which contradicts this feature's whole differentiator (personas reflect *real*
agent state, not decorative animation).

This addendum defines a 9-state set matched to signals that actually exist in this
codebase's chat pipeline — same count as Petdex, but every state has a real, traceable
trigger.

## The 9 states

| State | Trigger | Where the signal lives today |
|---|---|---|
| `idle` | no activity | default state |
| `waving` | a conversation is opened with zero messages (first-time greeting) | `Conversation` has no `Message[]` yet — a new client-side check, not an SSE event |
| `running` | a tool call just started | SSE `tool_call` event (`chatStream.ts:211`) |
| `thinking` | a tool result just came back, agent deciding what's next | SSE `tool_done` event (`chatStream.ts:224`) |
| `responding` | streaming the reply text | SSE `delta` event (`chatStream.ts:192,200`) |
| `waiting` | paused on a human-approval gate (an MCP tool needs the user's OK before it runs) | the real `approval_request` SSE event, forwarded end to end — see below |
| `review` | just produced a completed artifact (PRD/plan/tasks) for the user to look at | `Message.artifactRef` (`chat/types.ts:88`) present on the latest assistant message |
| `done` | finished cleanly | SSE `done` event (`chatStream.ts:276`), no error, no pending approval |
| `failed` | an error occurred | SSE `error` event (`chatStream.ts:298`) |

**Not carried over from Petdex:** `run left`, `run right`, `jumping`. No signal in this
product triggers screen-roaming or a "success bounce" distinct from `done` — inventing one
would mean art with no real behavior behind it, which is exactly what this feature is
designed not to be.

## What changes vs. the merged implementation

### 1. `PersonaAnimationStates` type and `personas.animation_states` column

Currently (`apps/web/components/platform/personas/types.ts`):
```ts
export interface PersonaAnimationStates {
    idle: string;
    thinking: string;
    responding: string;
}
```
Becomes a 9-key shape:
```ts
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
The backend type (`products/agent-platform/packages/schema/personas.ts`'s
`PersonaAnimationStates`) mirrors this — same 9 keys. The column is `jsonb`, so this is a
type-level change only; no migration needed for the column itself. The **publish-gate**
route (`POST /ops/personas/:id/publish`) currently checks `idle && thinking && responding`
are present — it must be updated to require all 9 keys before allowing publish, or a
persona could publish with the old 3-key set and silently render nothing for the other 6
states.

### 2. The reducer (`usePersonaAnimationState.ts`)

The current reducer takes one event type. The new version needs two additional inputs
beyond the SSE event stream, since `waving` and `waiting`/`review` aren't SSE events at
all — they're derived from conversation/message state:

- **`waving`**: computed once, client-side, from whether the active conversation has any
  messages yet — not part of the SSE reducer at all. This is a *display* decision made by
  whatever component renders `PersonaAvatar` for the chat header/conversation view: if
  `conversation.messages.length === 0`, render `waving` regardless of stream state; once
  the first message is sent, hand off to the SSE-driven reducer.
- **`review`**: not an SSE event at all — derived by inspecting `Message.artifactRef` after a
  message lands, since there's no dedicated wire event for "artifact ready" (the `artifactRef`
  payload rides inside the existing `done` event, per `chatStream.ts:280`).
- **`waiting`**: unlike `review`, this one **is** a real, distinct SSE event on the wire — the
  literal event name `approval_request` — but tracing it required two earlier, wrong guesses
  in this spec's drafting, corrected here for the record:

  1. First draft assumed `Message.approvalRequest` was the signal. Reasonable-looking, but
     an earlier revision of this spec "corrected" it away after grepping only backend
     DB-persistence code and finding no writer — that grep missed that the field is
     constructed **client-side**, not persisted server-side.
  2. Second draft (the correction just described) replaced it with
     `artifactRef.pmRunId`/`pmStepId`, based on a *different* HITL mechanism (the PM
     workflow's Mastra resumption gate). Real, but the wrong one — a distinct approval
     mechanism from what actually fires during ordinary chat.

  The accurate chain, traced end to end:
  - `apps/agent-orchestrator/src/routes/chat.ts:165` registers an approval channel per
    session: `sseApprovalChannels.set(sessionId, (payload) => sendEvent('approval_request', payload))`.
  - `apps/agent-orchestrator/src/routes/sessions.ts:47-48` pushes into that channel — a
    genuine MCP tool-call approval gate ("agent wants to call a stakes-gated tool, needs the
    user's OK"), separate from `chatStream.ts`'s own `delta`/`tool_call`/`tool_done`/`done`/
    `error` events but delivered on the *same* SSE stream.
  - `apps/web/hooks/useChat.ts:300-308` already has a live `case 'approval_request':` handler
    calling `onApprovalRequired`.
  - `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts:162-167` — `onApprovalRequired`
    constructs a real `Message` with `approvalRequest: { ..., status: 'pending' }` and pushes
    it into the `['messages', conversationId]` query cache.
  - `apps/web/app/[tenant]/dashboard/chat/page.tsx:72-84` — `handleApprove`/`handleDismiss`
    flip that same message's `approvalRequest.status` to `'approved'`/`'dismissed'` once
    resolved, so it doesn't stay `'pending'` forever.
  - `MessageItem.tsx:184`'s `{false && message.approvalRequest && (...)}` only disables the
    *visual approval banner* — a separate, already-known gap (nothing in the current UI lets
    a user actually resolve a pending approval by clicking anything in that banner).

  **Correction added after the 9-state animation branch's final review:** the paragraph
  above traces the *frontend/orchestrator* half of the chain accurately — that half is real
  and live. But the final whole-branch review found the *producer* side is not: nothing in
  this repo ever actually triggers `sessions.ts`'s approval push in production today.
  `mcp-server`'s `assertActionAllowed` (`mcp-server/src/tools/policy-guard.ts:58-62`) throws
  `PolicyDeniedError` for a stakes-gated tool instead of routing through the orchestrator's
  approval channel, and the per-request `sessionId` minted in `chat.ts:139` is never
  propagated to `mcp-server` in any header — so even a correctly-triggered approval could
  not address the right channel. The claim two lines above ("this field is genuinely
  populated today, in production, on every real MCP approval gate") was **wrong** — corrected
  here rather than silently reworded, so the pattern of this section (get it wrong twice,
  then a third time in a different way) is visible rather than repeating unnoticed. Practical
  upshot: Task 4 of the 9-state animation plan correctly wires `approval_request` →
  `waiting`, and that wiring is real and correct — it will fire the moment `mcp-server`'s
  approval flow is actually built to call it. Until then, `waiting` is reachable code with no
  live producer, not a bug in the animation branch.

  Conclusion: `approval_request` is forwarded as a **real** SSE event into the reducer
  (matching the literal wire event name, no renaming needed), not synthesized after the fact
  like `review` is — but as of this writing, no code path actually triggers it in production.

Proposed reducer shape — extend the event union rather than bolting on side-channel state,
so the whole thing stays a single pure function:

```ts
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
        case "tool_call": return "running";
        case "tool_done": return "thinking";
        case "delta": return "responding";
        case "approval_request": return "waiting";
        case "artifact_ready": return "review";
        case "done": return "done";
        case "error": return "failed";
        default: return _current;
    }
}
```

`approval_request` is the real SSE event name (matches the literal string used by
`chat.ts`/`sessions.ts` on the wire) — the calling component forwards it directly, the same
way it forwards `tool_call`/`delta`/etc. `artifact_ready` is the one synthetic event: no wire
event by that name exists, so the calling component dispatches it after inspecting the
latest message's `artifactRef` field (populated via the `done` event's payload, per
`chatStream.ts:280`). This keeps the reducer pure and testable exactly like the existing
one, while being precise about which of the two is a real forwarded event and which is
derived from message state.

`waving` is deliberately **not** a reducer case — it's a rendering decision made before the
reducer is even relevant (empty conversation), not a state transition triggered by an
event. The component wiring `PersonaAvatar` should render `waving` when
`conversation.messages.length === 0`, and only start feeding events into
`usePersonaAnimationState` once the first message exists.

`done` and `failed` auto-decay back to `idle` after **2.5 seconds** — visible long enough
to register as a distinct beat, short enough not to look stuck. Implemented as a
`setTimeout` in the component consuming the hook (e.g. `ChatHeader.tsx`), not inside the
pure reducer — keeps `reducePersonaAnimationState` side-effect-free and testable exactly
like today, and the timer is straightforward to clear/reset on unmount or a new message
arriving mid-decay.

### 3. `PersonaAvatar` and its call sites

No change to `PersonaAvatar.tsx`'s own logic — it already reads
`persona?.animationStates?.[state] ?? persona?.animationStates?.idle`, which works
unmodified for any state key, including the 6 new ones, as long as the asset exists.

Call sites (`ChatHeader.tsx`, `ConversationList.tsx`) need to start actually passing a
non-default `state` prop, which none of them do today (confirmed: no call site passes
`state` at all, so every persona currently renders permanently pinned to `idle`). This
addendum is also what finally makes the `usePersonaAnimationState` hook (built in the
original plan's Task 6 but never wired to any consumer, per the final whole-branch
review's dead-code finding) actually connect to something.

### 4. Art asset scope

9 states × however many personas are live means 9 assets per persona instead of 3 — the
publish-gate change in §1 makes this a hard requirement, not optional. This is a
Higgsfield generation-volume decision, not a code decision — flagged here so it's visible
before implementation starts, not discovered at asset-generation time.

## Non-goals (this addendum)

- `run left`/`run right`/`jumping` — no product signal maps to them, not building them.
- Changing the underlying SSE protocol to add real `approval_pending`/`artifact_ready`
  wire events — the synthetic-event approach (deriving them client-side from message
  fields) is intentionally chosen to avoid backend/orchestrator changes for this addendum.
  If a future need arises for the backend to push these as real-time events (rather than
  discovered after `done` lands), that's a separate, larger change.
- Retroactively re-publishing the 3 seeded draft personas — they still need real art
  regardless of state count; this addendum only changes what shape that art must arrive in.
