# Credit usage UI: account-wide panel + per-generation credit card

Date: 2026-09-04
Status: approved for planning

## Context

The credit system (`packages/foundation/credits`, schema in `packages/foundation/database/schema/credits.ts`) is live on dev but exposes only a single undifferentiated `balanceMicro` number to users. `CreditBalanceIndicator` in the sidebar shows that number as plain text with no breakdown and no interaction. There is no way for a user to see how their credits are being spent across text/image/video/audio, and generated media (images/videos) show no generation metadata or per-asset cost anywhere.

Three UI patterns from a competitor app were used as reference (not implemented as-is):
1. A per-conversation "session usage" popover with duration/turn count — **out of scope**, see Decisions below.
2. A per-generation credit badge that expands into a details card (model, aspect ratio, resolution, seed, batch, credits used).
3. An account-level "Your Credits" panel with a percent-consumed ring, breakdown by credit type, and a Top-up button.

This spec covers two independent features: the **account-wide credits panel** (merging patterns 1 and 3's breakdown-by-type layout into pattern 3's account-wide scope) and the **per-generation credit card** (pattern 2).

## Decisions made during brainstorming

- **Session-scoped usage (per-conversation breakdown, duration, turn count) is dropped.** The ledger has no `conversationId` link today (media-generation debits don't even set `jobId`), and duration/turns aren't tracked anywhere. Building this would require a ledger schema change to stamp every debit with a conversation reference. Not worth it for what the user actually wants, which is account-wide visibility.
- **Percent-consumed ring is "spent since last grant / last grant amount."** `credit_accounts` has no plan-period concept — just a running balance topped up by discrete `credit_grants` rows (`amountMicro`, `spentMicro`). The most recent grant row already tracks `spentMicro` against its own `amountMicro`, which gives an intuitive "how much of my last top-up have I used" ring without inventing new schema.
- **Top-up button links to `/dashboard/billing`.** Real checkout is blocked on the Stripe/Paddle decision (see `docs/superpowers/plans/2026-08-30-credit-system-open-items.md`); this is a placeholder destination, not new checkout infra.
- **"Open on canvas" for generated assets is NOT new work.** `InlineAttachmentCard.tsx` already wires image/video attachments to `window.__openCanvas()` / `__canvasUpdate('asset_open', ...)`. The credit card is additive to that existing card, not a replacement.
- **Credits-used-per-generation is captured at spend time, not derived from the ledger.** `spendCredits()` only returns the post-spend balance, and ledger debit rows for media generation don't carry a `jobId` today. Rather than adding that linkage, `generateImage.ts`/`generateVideo.ts` already compute `amountMicro` locally before calling `spendCredits` — that value is captured directly and threaded through to the tool's return value and stored on the message attachment. This sidesteps the missing-`jobId` blocker entirely for this feature; it does not fix the ledger's lack of job linkage in general.

## Feature 1: Account-wide credits panel

### Data

New credit-type bucketing, computed by aggregating `credit_ledger.jobType` (grouped by tenant, `kind = 'debit'`, summed `amountMicro`) into four buckets:

| jobType values | Bucket |
|---|---|
| `chat_message`, `agent_task`, `llm_tokens`, `tool_call`, `skill_run` | Text |
| `image_generation` | Image |
| `video_generation` | Video |
| `music_generation` | Audio |

This mapping lives in the new route handler only — it is not a schema change. `jobType` is a free-text column already populated by existing spend call sites; nothing upstream changes.

Percent-consumed ring: fetch the tenant's most recent `credit_grants` row (`order by createdAt desc limit 1`) and compute `spentMicro / amountMicro`. If no grant exists (unlimited plan, or a tenant with only legacy balance and no grant rows), omit the ring and show balance only.

### API

New route `GET /credits/usage-by-type` in `apps/api/src/routes/credits.ts`, following the existing `/credits/balance` and `/credits/ledger` handler pattern (same `requestContext.tenant.id` + `hasPermission(permissions, 'credits', 'read')` gate).

Response:
```ts
{
  unlimited: boolean;
  balanceMicro?: string;
  byType?: { text: string; image: string; video: string; audio: string }; // micro, positive numbers (spend magnitude)
  totalMicro?: string; // sum of byType, should equal total debits
  lastGrant?: { amountMicro: string; spentMicro: string; grantType: string } | null;
}
```

Implementation: one grouped-sum query against `credit_ledger` (`kind = 'debit'`) per tenant, plus the single most-recent-grant lookup. Both are straightforward additions alongside the existing `getBalance`/`getLedger` functions in `packages/foundation/credits/src/read.ts` — add a `getUsageByType(tenantId)` function there rather than inlining SQL in the route, matching how `getBalance`/`getLedger` are already factored.

### Web

- `apps/web/lib/hooks/useCredits.ts`: add `useCreditUsageByType()` — same shape as `useCreditBalance()` (`useQuery`, `staleTime: 30_000`, hits `/api/v1/credits/usage-by-type`).
- `CreditBalanceIndicator.tsx` becomes clickable (wrap in a button/popover trigger) and opens a new `CreditsPanel.tsx` component (`apps/web/components/platform/credits/CreditsPanel.tsx`):
  - Ring (or omitted per above) + balance headline
  - Rows: Text credits / Image credits / Video credits / Audio credits (converted via existing `microToCredits`)
  - Total credits row
  - Top-up credits button → `/${tenantSlug}/dashboard/billing`
- Unlimited-plan tenants keep today's static "Unlimited credits" text, unchanged — the panel only opens for metered tenants.
- Light theme, consistent with rest of the app (the dark reference screenshot was a different product).

### Testing

- API: unit test for `getUsageByType` bucketing (each jobType maps to the right bucket; unknown/legacy jobType values fall into Text as a safe default) and for the "no grants yet" ring-omission path.
- Web: component test for `CreditsPanel` rendering the four rows + total from mocked hook data, and for the unlimited branch rendering nothing (matches existing `CreditBalanceIndicator` test pattern).

## Feature 2: Per-generation credit card

### Generation tools

`apps/agent-orchestrator/src/mastra/tools/generateImage.ts` and `generateVideo.ts` both already:
- compute `amountMicro = costMicro(rate.schema, { count: 1 })` before calling `spendCredits`
- know their model via a local `IMAGE_MODEL` / `VIDEO_MODEL` constant
- return `{ fileId, name, fileType, size }` from `uploadGeneratedFile()`'s result on success

Changes:
- Capture `amountMicro` (rename locally to `creditsUsedMicro` for clarity at the call site) and pass it through to `uploadGeneratedFile()` alongside `model`, so it lands in the same place `fileId`/`name`/`fileType`/`size` already come from.
- `aspectRatio`, `resolution`, `seed`, `batch` are NOT available from the current gateway request/response (`generateImage`'s request body is just `{ model, prompt }`; the response is `{ imageBase64, mimeType, refused, reason }` — no metadata fields exist at that layer). Emitting them as real values isn't possible without adding those parameters to the tool's `inputSchema` and threading them through the gateway call, which is a separate change to the generation tool's capabilities, not just its credit reporting. **This spec stores only what's genuinely known today: `model` and `creditsUsedMicro`.** `aspectRatio`/`resolution`/`seed`/`batch` are left off the card rather than faked with placeholder values; the card's field grid only renders fields that are present.
- Extend `outputSchema` on both tools with `creditsUsedMicro: z.string().optional()` and `model: z.string().optional()`.

### Storage

Extend `MessageAttachment` (`apps/web/components/platform/chat/types.ts`) with an optional field:
```ts
generation?: {
  creditsUsedMicro: string;
  model: string;
  createdAt: string; // ISO, set when the attachment is built server-side
}
```
Populated wherever `uploadGeneratedFile()`'s result is assembled into a message's `attachments` array (same code path that already sets `fileId`/`name`/`fileType`/`size`). No new table, no new jsonb column — `messages.attachments` already exists and is jsonb.

### Web

- `apps/web/components/platform/chat/InlineAttachmentCard.tsx`: when `file.generation` is present and `type` is `image`/`video`, render a small credit-cost pill (e.g. "◐ 0.31") in the existing top-left badge corner, next to the type badge — matching the reference screenshot's collapsed state.
- New component `apps/web/components/platform/chat/GeneratedAssetCard.tsx`: wraps `InlineAttachmentCard`, adds click-to-expand behavior on the credit pill (not the whole card, to avoid conflicting with the existing "open on canvas" click) that reveals a small popover/panel with Model, Credits used, and Created — the file grid layout from the reference screenshot, minus the fields that aren't populated (Aspect ratio, Resolution, Seed, Batch).
- Wire `GeneratedAssetCard` in wherever `InlineAttachmentCard` is currently rendered for message attachments (in `MessageItem.tsx`), conditionally on `file.generation` being present — non-generated (user-uploaded) attachments keep rendering bare `InlineAttachmentCard` unchanged.
- "Open on canvas" behavior is untouched — it's `InlineAttachmentCard`'s existing `handleClick`, still wired the same way.

### Testing

- Orchestrator: unit test that `generateImage`/`generateVideo` thread `creditsUsedMicro` and `model` through to `uploadGeneratedFile()`'s input and the tool's return value.
- Web: component test for `GeneratedAssetCard` — renders the credit pill when `generation` is present, omits it when absent (plain `InlineAttachmentCard` behavior preserved), and expands to show only the populated fields.

## Out of scope (explicitly)

- Per-conversation session-usage popover, duration, turn count (see Decisions).
- Real Top-up checkout flow (blocked on payment provider decision).
- Aspect ratio / resolution / seed / batch capture (would require changing the generation tools' input/output contract with the gateway — separate from credit reporting).
- Backfilling `generation` metadata onto previously-generated assets (only new generations after this ships will show the card).
