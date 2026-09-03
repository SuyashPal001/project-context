# Generation confirm gate

Date: 2026-09-03 (rev 2 — folds in an independent review's findings)

## Summary

None of the four shipped generation tools (`generate_image`, `edit_image`,
`generate_song`, `generate_video`) show the user a cost or a confirm step
before spending credits. The agent decides to call the tool, credits are
charged on success, and the user finds out only from the result — or from
a failure. This adds a pause-and-confirm step in front of all four,
reusing the existing in-process pause/resume mechanism
`ask_clarifying_questions` already established (`sendEvent` + an awaited
Promise resolved via a pending-request map, with a timeout), and reusing
the existing `ApproveCost` component + `GET /credits/estimate` endpoint
for the cost/balance display, rather than building either from scratch.

**Revision note:** rev 1 of this spec was independently reviewed and found
to point at the wrong frontend hook (`useAgentEvents.ts`, the WebSocket
bridge, instead of `useChat.ts`, the SSE path actually used by web chat),
mirror a render path that is hard-disabled (`MessageItem.tsx`'s
`{false && message.approvalRequest && (...)}`), omit the entire
API-Lambda half of its own persistence design (a DB column + migration +
zod schema field + a new PATCH route + a Lambda deploy, not just an
orchestrator-side file), and — most significantly — reinvent a cost/
balance/sufficiency display from scratch without noticing
`ApproveCost.tsx` + `GET /credits/estimate` already exist and do most of
it, including the balance-sufficiency check rev 1 dropped entirely. All
fixed below; sections kept from rev 1 are marked unchanged.

**Still not modeled on the MCP write-tool approval gate**
(`/mcp/approval-request` in `apps/agent-orchestrator/src/routes/sessions.ts`)
— confirmed by the review as the right call, not an oversight: that gate
exists because `mcp-server` is a separate process with no in-process
handle on the running tool call. Generation tools already run in-process
with `sendEvent`/`sessionId`/`tenantId`/`userId` on `requestContext` (the
same context `ask_clarifying_questions` reads today) — the HTTP
round-trip that gate uses has no purpose here.

## Goals

- Every credited generation call shows the user a cost, balance, and a
  Confirm/Cancel choice before the gateway is called.
- Charge-after-success stays exactly as it is today — this only adds a
  gate *before* generation starts. Unlike rev 1, this revision does
  **not** move `resolveRate`/`costMicro` earlier in each tool — the
  charge-time rate resolution is untouched, and the confirm-time estimate
  is independently resolved via `GET /credits/estimate` (already
  documented there as "a preview, not a reservation — the authoritative
  check lives inside `spend_credits()`"). Two independent resolutions can
  disagree if a rate changes mid-flight; that's an accepted, pre-existing
  property of `ApproveCost`'s design, not a new risk this spec
  introduces.
- Reuse `ApproveCost` for the cost/balance/sufficiency/unlimited display,
  not a new bespoke card.
- One shared backend helper, not four copies of the same
  send-event/wait/timeout logic.

## Non-goals

- Real latency-based time estimates. **Cut from this revision entirely**
  (rev 1 planned a per-modality guess; `ApproveCost` has no time-estimate
  slot, and extending a shared credits component for a number this spec
  itself called "provisional guesses" isn't worth it). A time estimate is
  a legitimate follow-up if wanted, built on real p50 latency data once
  it exists — not part of this gate.
- Editing or cancelling an in-flight generation after confirming.
- A "remember my choice" / auto-confirm setting.
- Solving prompt-level retry loops after a decline (see §5 — flagged as
  an accepted gap, not solved here).
- Reachability from non-interactive contexts (task workers, an
  autonomous agent invocation with no live SSE session). Director and
  Producer are only reachable via `chatStream.ts`'s `resolveAgent` today,
  which always has a live session — the skip condition in §2 exists for
  when that stops being true, not because it's exercised now.

## Design

### 1. Where the gate sits in each tool (revised — no rate-resolution reordering)

Each tool's `execute()` gains one step near the top, before the gateway
`fetch`, and is otherwise unchanged — specifically, the existing
post-success `isUnlimited` → `resolveRate` → `costMicro` → `spendCredits`
block stays exactly where and how it is today (`generateImage.ts:71-90`,
`editImage.ts:89-108`, `generateSong.ts:65-84`, `generateVideo.ts:70-89`).

**Skip conditions — the gate returns confirmed immediately, no
`sendEvent`, no pause:**
- `isUnlimited(tenantId)` is true — nothing to confirm against, per
  product decision (no lightweight "this will generate" notice either;
  unlimited tenants see no gate at all, confirmed).
- No active rate resolves for `(resourceType, subject)` — matches the
  existing `UNBILLED` log-and-proceed precedent; a tenant cannot cheaply
  engineer this to bypass the gate (rates are global, not per-tenant, and
  changing them needs ops access), so this is a weak but acceptable
  bypass, same as the existing charge-time behavior it mirrors.
- **New: no active session** (`sendEvent`/`sessionId`/`tenantId`/`userId`
  missing from `requestContext`) — mirrors `askClarifyingQuestionsTool`'s
  own guard at `askClarifyingQuestions.ts:38-40`. Not reachable today
  (see Non-goals), included so this doesn't silently hang or throw the
  day these tools become reachable from a non-SSE context.

### 2. Shared helper

New file `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts`:

```ts
export async function confirmGenerationOrDecline(
  execContext: ToolExecutionContext,
  resourceType: string,   // e.g. 'image_generation' — must be a valid
                           // CreditResourceType, see §6
  subject: string,        // e.g. 'gemini-3-pro-image-preview'
  label: string,          // user-facing, e.g. 'Generate image'
): Promise<{ confirmed: boolean }>
```

No cost/rate fields in the return type — unlike rev 1, this helper does
not resolve or return a rate. It only decides whether to show the gate
and reports the user's decision. Internally: `isUnlimited` check →
`resolveRate` (to decide whether to skip, not to compute a number) → if
either short-circuits, or no active session, return `{confirmed: true}`
immediately. Otherwise:
- generate a `confirmationId`
- `sendEvent('generation_confirm_request', { confirmationId, resourceType, subject, label })`
- persist via `saveGenerationConfirmRequest` (§4)
- register in `pendingGenerationConfirmations` (keyed by `confirmationId`)
  **and** in a session→Set index `sessionActiveGenerationConfirmations`
  (§5 — needed for stream-cancel cleanup, and a `Set` not a single value
  because concurrency handling in §5 may need to look up "is anything
  already pending for this session")
- **concurrency guard**: if `sessionActiveGenerationConfirmations.get(sessionId)`
  is already non-empty when this call starts, **decline immediately**
  without sending a second event — see §5 for why, and why this is a
  documented limitation rather than a queue.
- await a Promise resolved by `pendingGenerationConfirmations`, 5-minute
  timeout resolving to `{ confirmed: false }` (auto-decline — a longer
  window than the MCP approval gate's 30s, since deciding whether to
  spend credits isn't the same time pressure as approving a live write
  action mid-turn; and, per the reviewer's independent check, safe
  against any wall-clock kill — see §7).

Each of the four tools calls this once, near the top of `execute()`:

```ts
const confirm = await confirmGenerationOrDecline(
  execContext, 'image_generation', IMAGE_MODEL, 'Generate image',
)
if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }
```

**New refusal reason: `DECLINED`.** Both `directorAgent.ts` and
`producerAgent.ts` need an explicit line for it — `directorAgent.ts`'s
image-rules block currently has no catch-all for an unlisted reason
(`:21-25`), so `DECLINED` would otherwise fall through with no guidance.
Exact wording to add to each agent's refusal-handling bullets:

> - "DECLINED": the user chose not to proceed when asked to confirm the
>   cost. Say so plainly and do not retry or re-ask in the same turn.

**Accepted gap, not solved by this spec:** nothing stops the model from
calling the same tool again later in the conversation after a decline,
re-triggering a fresh confirm gate. This is prompt-level discipline only
("do not retry... in the same turn"), not a server-side enforcement. A
per-turn or per-conversation cooldown is a reasonable follow-up if this
proves to be a real problem in practice; not built here.

### 3. Frontend (corrected — right hook, right render pattern, reused component)

**Wiring lives in `apps/web/hooks/useChat.ts`**, not `useAgentEvents.ts`.
`useChat.ts` is the SSE path web chat actually uses (`useChatStream.ts`
imports it); `useAgentEvents.ts` is a separate WebSocket bridge whose
`platformAgent`-only path never sets `sendEvent` on `RequestContext` at
all — a branch added there would be dead code.

- New case in `useChat.ts`'s SSE event switch (alongside
  `'approval_request'`/`'clarification_request'` at `useChat.ts:327-343`):
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
- New `sendGenerationConfirm(confirmationId, decision)` alongside
  `sendApproval` (`useChat.ts:387-405`), same shape: POSTs
  `{ confirmationId, decision: 'approved' | 'declined' }` to
  `${CHAT_ENDPOINT}/generation-confirm`.

**Render pattern: panel-takeover overlay, matching the live clarification
precedent — not an inline `MessageItem` card.** `MessageThread.tsx`
derives `pendingClarificationMessage` (`:76`) from "last message's
`clarificationRequest` still `pending`" and renders it as a panel-wide
overlay (`:359-370`), specifically *not* inline — `MessageItem.tsx`
deliberately skips rendering it while pending (`:292-294`, with a comment
explaining why: `ApprovalCard`'s inline path is disabled entirely at
`:284` (`{false && message.approvalRequest && (...)}`), so there is no
live inline precedent to copy). This gate should follow the clarification
precedent, not the dead approval one:
- `MessageThread.tsx` gets a parallel derived value,
  `pendingGenerationConfirmMessage`, same "last message, status pending"
  shape.
- The overlay renders `ApproveCost` (reused as-is, not a new bespoke
  card) with `resourceType`/`subject` from the message, `onApprove`
  wired to `sendGenerationConfirm(id, 'approved')`, `onCancel` wired to
  `sendGenerationConfirm(id, 'declined')`.
- The composer hides while pending, the same way it already does for a
  pending clarification (`page.tsx` — check the exact conditional guard
  before wiring; it exists, comment at `page.tsx:127` references it).

**Types** (`apps/web/components/platform/chat/types.ts`): new
`GenerationConfirmRequest` interface —
`{ id: string; resourceType: string; subject: string; label: string; status: 'pending' | 'approved' | 'declined' }`
— added to the `Message` shape alongside `approvalRequest`/
`clarificationRequest`.

### 4. Persistence (corrected — full path, not one file)

Rev 1 named only `apps/agent-orchestrator/src/persistence.ts`. The full
path, mirroring the approval request's actual shape exactly:

1. **`products/agent-platform/packages/schema/conversations.ts`** — new
   `jsonb('generation_confirm_request')` column on the messages table,
   alongside the existing `approvalRequest: jsonb('approval_request')`
   (`:63`).
2. **A Drizzle migration** for that column (the approval column's own
   migration is `packages/foundation/database/migrations/0058_*.sql` —
   same shape, new column).
3. **`products/agent-platform/packages/api/routes/messages.ts`**:
   - the `POST /messages/save` zod schema (`:169-176`) gains a
     `generationConfirmRequest: z.object({...}).optional()` field — an
     unlisted field is silently dropped by `safeParse`, so this is not
     optional to skip.
   - the insert at `:234` includes it.
   - a new `PATCH /:conversationId/messages/:messageId/generation-confirm`
     route, mirroring the existing approval PATCH route
     (`:342-384` — read/merge/write the jsonb column, same pattern).
4. **`apps/agent-orchestrator/src/persistence.ts`**:
   `saveGenerationConfirmRequest`/`updateGenerationConfirmRequest`, thin
   HTTP clients into the routes above — same shape as
   `saveApprovalRequest`/`updateApprovalRequest` (`:159-208`).
5. **This requires a Lambda deploy** (`sam deploy`, after rebuilding
   `packages/foundation/*`/product `dist/` per the stale-`dist/`
   footgun), not just `./deploy.sh` — the schema/route changes live in
   the API Lambda, not the VM services. `apps/agent-orchestrator` and
   `apps/web` changes still need their own `pm2 restart`/`./deploy.sh`
   respectively, as usual — these are three separate deploy actions, not
   one.

**Refresh-mid-confirm is an accepted, pre-existing limitation, not solved
here.** The client-side placeholder message id is a fresh
`crypto.randomUUID()` that does not match the backend's persisted
message id, so a page refresh while a confirm is pending shows the
persisted `pending` row with no live Promise behind it — a dead card
until the 5-minute timeout resolves it server-side and the next fetch
picks up the resolved state. This is identical to the existing
clarification flow's behavior (not a regression this spec introduces);
fixing it for both flows together is out of scope here.

### 5. Concurrency and stream-cancel cleanup (new sections — gaps in rev 1)

**Concurrency: at most one pending confirm per session, fail closed.**
`MessageThread.tsx`'s overlay only ever considers the *last* message, so
two simultaneous pending confirms (e.g. two generation tool calls in one
agent turn) would only surface one card — the other's Promise would sit
until timeout, silently. Rather than build multi-pending UI, the shared
helper declines a second confirm request outright if one is already
active for the session (see §2's concurrency guard). This is a real,
deliberate limitation: a turn that tries to generate two things at once
will have the second one auto-decline rather than queue. Acceptable
because nothing in the current agent designs calls two generation tools
in a single turn; revisit if that changes.

**Stream-cancel cleanup**, mirroring `chat.ts:202-232`'s existing
handling for clarifications (`sessionActiveClarification` resolved on
`ReadableStream.cancel()` "so the server-side agent doesn't stay blocked
... after the client has gone away"): the same `cancel()` handler gets an
equivalent block for `sessionActiveGenerationConfirmations` — on
disconnect, resolve every pending confirmation for that session as
declined, clear the timer, delete from both maps, and persist the
`declined` status. Without this, a closed tab leaves the agent blocked
for the full 5-minute timeout holding the Mastra stream open.

### 6. `RESOURCE_TYPES` widening

`apps/api/src/routes/credits.ts:16`'s `RESOURCE_TYPES` allowlist for
`GET /credits/estimate` is currently
`['llm_tokens', 'message', 'tool_call', 'skill_run']` — missing
`image_generation`/`music_generation`/`video_generation`, even though
the DB enum already has all three (`packages/foundation/database/schema/credits.ts:18`).
One-line widening to add them, required for `ApproveCost` to work for
any of these three resource types — without it, every confirm card hits
the existing `isError` branch ("Couldn't estimate cost — balance will be
checked when this runs") and never shows a real number.

## Tradeoffs

- **Every call shows the gate, no bypass** (unchanged from rev 1) —
  matches the explicit "user will never know otherwise" concern directly.
  A "don't ask again" preference is a legitimate future ask, deliberately
  out of scope.
- **No time estimate in this revision** — cut because `ApproveCost` has
  no slot for one and rev 1's numbers were guesses. Reusing the shipped
  component outweighs the (unverified, provisional) value a guessed
  number would have added.
- **At most one pending confirm per session** — a real UX limitation for
  a hypothetical multi-generation turn, accepted because no current agent
  design triggers it.
- **Confirm-time estimate and charge-time rate are resolved
  independently** — can disagree if pricing changes mid-flight. Accepted
  because `ApproveCost` already documents this exact tradeoff for every
  other resource type it estimates; not a new risk this feature
  introduces.
- **`DECLINED` retry-loop prevention is prompt-level only** — a
  determined model could re-trigger the gate repeatedly in later turns.
  Accepted as an unsolved gap rather than over-building a cooldown
  mechanism for a failure mode that hasn't been observed yet.

## Testing

- Unit: `confirmGenerationOrDecline` — unlimited tenant skips (`sendEvent`
  never called), no-rate skips, no-active-session skips, a second call
  while one is already pending for the session declines immediately with
  no second `sendEvent`, normal case sends the event and resolves on a
  mocked confirm, timeout resolves to declined after the timer fires
  (fake timers), decline resolves promptly without waiting for timeout.
- Unit: each of the four tools' `execute()` — a `confirmed: false`
  response short-circuits before any `fetch` call, returns
  `{refused: true, refusalReason: 'DECLINED'}`, and never calls
  `spendCredits`. Confirm the existing charge-time `resolveRate`/
  `costMicro`/`spendCredits` block is byte-for-byte unchanged.
- Integration: `PATCH .../generation-confirm` — resolves the correct
  pending entry, persists the decision, an unknown/expired id is a clean
  404. `GET /credits/estimate` accepts the three new resource types.
- Integration: SSE `cancel()` resolves any pending confirmation for that
  session as declined and clears both maps.
- Manual: request an image in dev, see the `ApproveCost` overlay with a
  real resolved cost and balance figure, confirm, verify the charge
  lands. Request again and cancel, verify no charge and the agent states
  the decline plainly without retrying. Confirm an unlimited tenant sees
  no overlay at all. Trigger two generations in one turn (if reachable)
  and confirm the second declines cleanly rather than hanging.
