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
| `waiting` | paused on a human-approval gate (HITL) | `Message.approvalRequest` (`chat/types.ts:84`), status `'pending'` |
| `review` | just produced an artifact (PRD/plan/tasks) for the user to look at | `Message.artifactRef` (`chat/types.ts:88`) present on the latest assistant message |
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
- **`waiting`** and **`review`**: not present in the current `ChatStreamEventType` union at
  all (no `approval_requested` or `artifact_ready` SSE event exists — those are read from
  the persisted `Message` object's `approvalRequest`/`artifactRef` fields after the message
  lands, not from a stream event). The reducer needs a way to receive "the latest assistant
  message now has a pending approval" / "the latest assistant message now has an
  artifactRef" as inputs, distinct from the raw SSE event stream.

Proposed reducer shape — extend the event union rather than bolting on side-channel state,
so the whole thing stays a single pure function:

```ts
export type PersonaAnimationState =
    | "idle" | "waving" | "running" | "thinking" | "responding"
    | "waiting" | "review" | "done" | "failed";

export type ChatStreamEventType =
    | "tool_call" | "tool_done" | "delta" | "done" | "error"
    | "approval_pending" | "artifact_ready";

export function reducePersonaAnimationState(
    _current: PersonaAnimationState,
    event: ChatStreamEventType,
): PersonaAnimationState {
    switch (event) {
        case "tool_call": return "running";
        case "tool_done": return "thinking";
        case "delta": return "responding";
        case "approval_pending": return "waiting";
        case "artifact_ready": return "review";
        case "done": return "done";
        case "error": return "failed";
        default: return _current;
    }
}
```

`approval_pending` and `artifact_ready` are **not** real SSE event names — they're
synthetic events the calling component dispatches after inspecting the completed
message's `approvalRequest`/`artifactRef` fields (e.g. right after the `done` SSE event
lands and the assistant message is persisted). This keeps the reducer pure and testable
exactly like the existing one, while acknowledging these two states derive from message
data, not the wire event.

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
