# Generation confirm gate

Date: 2026-09-03

## Summary

None of the four shipped generation tools (`generate_image`, `edit_image`,
`generate_song`, `generate_video`) show the user a cost or a confirm step
before spending credits. The agent decides to call the tool, credits are
charged on success, and the user finds out only from the result — or from
a failure. This adds a pause-and-confirm step in front of all four,
reusing the existing in-process pause/resume mechanism
`ask_clarifying_questions` already established (`sendEvent` + an awaited
Promise resolved via a pending-request map, with a timeout that resolves
to a safe default), rather than inventing a new one.

**Not modeled on the MCP write-tool approval gate** (`/mcp/approval-request`
in `apps/agent-orchestrator/src/routes/sessions.ts`), despite the visual
similarity of its `ApprovalCard`. That gate exists because `mcp-server` is
a separate process calling back into the orchestrator over HTTP with no
in-process access to the running tool call. Generation tools already run
in-process with `sendEvent`/`sessionId`/`tenantId`/`userId` on
`requestContext` (same context `ask_clarifying_questions` reads today) —
the HTTP round-trip has no purpose here.

## Goals

- Every credited generation call shows the user an estimated cost and a
  Generate/Cancel choice before the gateway is called.
- Charge-after-success stays exactly as it is — this only adds a gate
  *before* generation starts, it does not move where the charge happens.
- One shared helper, not four copies of the same resolve-rate/wait/timeout
  logic.

## Non-goals

- Real latency-based time estimates. No production data exists yet;
  ships with a rough per-modality constant, explicitly flagged as
  provisional.
- Editing or cancelling an in-flight generation after confirming — this
  gate is a single yes/no before the call starts, nothing mid-flight.
- A "remember my choice" / auto-confirm setting. Every call shows the
  gate; skipping it is a future, separate decision if it turns out to be
  friction rather than useful visibility.

## Design

### 1. Where the gate sits in each tool

Today, each generation tool's `execute()` resolves the credit rate only
*after* a successful gateway response, purely to compute the charge
amount. The confirm gate needs the rate — and the resulting cost figure —
*before* the gateway is called, so `resolveRate`/`costMicro` moves earlier
in each tool. The actual `spendCredits` call stays exactly where it is
today, after a successful, shape-validated response. This preserves the
existing charge-after-success invariant; it only inserts a pause between
"rate resolved" and "gateway called."

**Skip conditions — the gate returns confirmed immediately, no
`sendEvent`, no pause:**
- `isUnlimited(tenantId)` is true — nothing to confirm against, per
  product decision (no lightweight "this will generate" notice either;
  unlimited tenants see no gate at all).
- No active rate resolves for `(resourceType, subject)` — matches the
  existing `UNBILLED` log-and-proceed precedent for a misconfigured
  environment; blocking generation on a pricing gap would be a worse
  failure mode than the existing loud-log-and-proceed-uncharged one.

### 2. Shared helper

New file `apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts`:

```ts
export async function confirmGenerationOrDecline(
  execContext: ToolExecutionContext,
  resourceType: string,      // e.g. 'image_generation'
  subject: string,           // e.g. 'gemini-3-pro-image-preview'
  label: string,             // user-facing, e.g. 'Generate image'
  estimateSeconds: number,   // rough per-modality constant, see §5
): Promise<
  | { confirmed: true; rateId: string; rateVersion: number; amountMicro: bigint }
  | { confirmed: true; rateId: null; rateVersion: null; amountMicro: null }  // unlimited or no rate — gate skipped
  | { confirmed: false }
>
```

Internally: `isUnlimited` check → `resolveRate` → if either short-circuits,
return the skip variant. Otherwise `costMicro`, `sendEvent('generation_confirm_request', {...})`,
persist via `saveGenerationConfirmRequest`, await a Promise resolved by
`pendingGenerationConfirmations`, 5-minute timeout resolving to
`{ confirmed: false }` (auto-decline, matching the "safer default on
silence" reasoning the existing clarification/approval timeouts already
use — but 5 minutes, not 30 seconds, since deciding whether to spend
credits is not the same time pressure as approving a live write action
mid-turn).

Each of the four tools calls this once, near the top of `execute()`,
before the gateway `fetch`:

```ts
const confirm = await confirmGenerationOrDecline(
  execContext, 'image_generation', IMAGE_MODEL, 'Generate image', 10,
)
if (!confirm.confirmed) return { refused: true, refusalReason: 'DECLINED' }
```

The pre-resolved `rateId`/`rateVersion`/`amountMicro` (when present) are
threaded into the existing post-success charge block, replacing that
block's own `resolveRate`/`costMicro` calls — the rate is resolved once,
not twice, and the amount shown to the user is guaranteed to be the
amount charged (no re-resolution race between confirm and charge).

**New refusal reason: `DECLINED`.** Each tool's existing
`refusalReason` vocabulary (`GENERATION_FAILED`, `STORAGE_FAILED`, etc.)
gains this one value. Each agent's instructions (`directorAgent.ts`,
`producerAgent.ts`) need a line telling the model to state plainly that
the user declined, not to retry or treat it as an error.

### 3. New types, persistence, endpoint

Mirrors `ClarificationRequest`/`ApprovalRequest`'s shape in spirit, but as
its own type — the payload is genuinely different (a cost/time estimate,
not a tool name and arguments):

**`apps/agent-orchestrator/src/types.ts`:**
```ts
export interface GenerationConfirmRequest {
  id: string
  label: string               // 'Generate image'
  resourceType: string
  subject: string
  amountMicro: string         // bigint serialized as string over the wire
  estimateSeconds: number
  status: 'pending' | 'confirmed' | 'declined'
  decisionAt?: string
}
export const pendingGenerationConfirmations = new Map<string, {
  resolve: (confirmed: boolean) => void
  messageId?: string
  conversationId?: string
  idToken?: string
}>()
```

**`apps/agent-orchestrator/src/persistence.ts`:** `saveGenerationConfirmRequest`
/ `updateGenerationConfirmRequest`, same shape as the existing
`saveApprovalRequest`/`updateApprovalRequest` pair (persist to the
conversation so a refreshed page still shows the resolved state).

**`apps/agent-orchestrator/src/routes/sessions.ts`:** new
`POST /api/chat/generation-confirm` (+ `OPTIONS` preflight, copying the
existing `/api/chat/approval` block verbatim for CORS), body
`{ confirmationId: string; confirmed: boolean }`, resolves the pending
Promise, persists the decision.

### 4. Frontend

New `apps/web/components/platform/chat/GenerationConfirmCard.tsx`,
matching the reference screenshot's shape — title ("Confirm · Generate"),
one-line description, a cost badge, a time estimate, a collapsible
"Details" section (resourceType/subject, for anyone who wants to see
what's actually being charged), and Cancel/Generate buttons. Deliberately
**not** `ApprovalCard` reused as-is — that card's visual language
(shield icons, red "Irreversible" badge, "Approval needed before I
continue") is built for write-tool risk framing, not a routine paid
action; forcing this into that shape would misrepresent a normal
generation as dangerous.

Wired through the same chain `ApprovalCard` already uses:
- `apps/web/components/platform/chat/types.ts`: `GenerationConfirmRequest`
  interface (mirrors the backend type), added to the `Message` shape
  alongside `approvalRequest`.
- `apps/web/hooks/useAgentEvents.ts`: new `case 'generation_confirm_request':`
  branch alongside the existing `case 'approval_request':`.
- `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`: new
  `onGenerationConfirmRequired` callback, same pattern as
  `onApprovalRequired` at line ~292 — creates a placeholder assistant
  message carrying the pending confirm request.
- `apps/web/components/platform/chat/MessageItem.tsx`: renders
  `GenerationConfirmCard` when a message carries a pending
  `generationConfirmRequest`, same conditional shape as the existing
  `ApprovalCard` render.
- Generate/Cancel button handlers POST to
  `/api/chat/generation-confirm`, same fetch-and-optimistically-update
  pattern the existing approve/dismiss handlers use.

### 5. Time estimates (provisional)

No real per-modality latency data exists yet. Ship fixed constants,
one per tool, defined alongside each tool's model constant:

| Tool | `estimateSeconds` |
|---|---|
| `generate_image` / `edit_image` | 10 |
| `generate_song` | 15 |
| `generate_video` | 90 |

**Explicitly flagged as provisional** — once generation latency is
tracked (it already flows through `latency.observe({adapter}, ms)` in
each gateway adapter), these should become real p50s read from that data,
not hand-picked guesses. Not this spec's job to build that pipeline;
noted so it isn't mistaken for a finished number.

## Tradeoffs

- **Every call shows the gate, no bypass.** Simpler to reason about and
  matches your explicit "user will never know otherwise" concern more
  directly than a partial rollout (e.g. video-only) would. Cost: an extra
  click on every generation, including ones a user might trust blindly
  after the first few. A "don't ask again" preference is a legitimate
  future ask, deliberately out of scope here.
- **Estimate seconds are guesses, not measurements.** Flagged rather than
  hidden. Shipping with a wrong-but-labeled-provisional number is better
  than blocking this feature on building a latency-tracking pipeline
  first.
- **New persisted message type, not reuse of `ApprovalRequest`.** More
  new code (type, persistence functions, one endpoint) than forcing the
  existing shape to carry an extra `amountMicro` field would cost — but
  the existing shape's `toolName`/`arguments`/`description` fields don't
  fit a cost confirmation, and stretching it would make `ApprovalCard`
  branch on two unrelated concerns (write-tool risk vs. spend
  confirmation) in one component.

## Testing

- Unit: `confirmGenerationOrDecline` — unlimited tenant skips
  (`sendEvent` never called), no-rate skips, normal case sends the event
  and resolves on a mocked confirm, timeout resolves to declined after
  the timer fires (use fake timers), decline resolves promptly without
  waiting for timeout.
- Unit: each of the four tools' `execute()` — a `confirmed: false`
  response short-circuits before any `fetch` call, returns
  `{refused: true, refusalReason: 'DECLINED'}`, and — critically — never
  calls `spendCredits`.
- Integration: `POST /api/chat/generation-confirm` — resolves the correct
  pending entry by `confirmationId`, persists the decision, a decision
  for an unknown/expired id is a clean 404 rather than a throw.
- Manual: request an image in dev, see the confirm card with a real
  resolved cost figure, click Generate, confirm the charge lands; request
  again and click Cancel, confirm no charge and the agent states the
  decline plainly. Repeat once for video to confirm the longer estimate
  renders correctly. Confirm an unlimited tenant sees no card at all.
