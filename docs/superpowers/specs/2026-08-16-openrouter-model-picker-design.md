# OpenRouter-backed model picker

## Context

The chat-premium-polish pass explicitly scoped out "model picker + autonomy-mode
selector (needs agent-orchestrator routing)" as a future sub-project. This is that
sub-project's first slice: a per-conversation model picker in the chat input, backed by
a new OpenRouter adapter in `inference-gateway`.

Investigation before design turned up more existing infrastructure than expected, and
one real gap:

- `packages/foundation/database/schema/integrations.ts` already has an `llm_providers`
  table with `provider` (enum already includes `'openrouter'`), `model`,
  `costPerToken`, `displayName`, `isDefault`, `isPlatform`, `status: 'live' |
  'coming_soon'`. `GET /api/v1/llm-providers` and `agent.llmProviderId` (+ a mutation to
  change it) already exist.
- `apps/web/components/platform/chat/ChatInput.tsx` already accepts
  `providers`/`llmProviderId`/`onModelChange` props — nothing renders them. Dead
  plumbing, same shape as the `ask_clarifying_questions` prompt gap fixed earlier this
  week.
- **The gap**: `llmProviderId` only affects the mobile WebSocket relay path
  (`products/agent-platform/packages/api/routes/_orchestrator.ts` →
  `packages/foundation/ai/src/config/bundler.ts`, which does look up `llmProviders`
  rows). The web chat (SSE, Mastra `platformAgent`) hardcodes three fixed model
  connectors in `apps/agent-orchestrator/src/mastra/model.ts` and never reads
  `llmProviderId` at all. Today, changing an agent's `llmProviderId` has zero effect on
  what answers you in the web chat UI.

`inference-gateway` (`apps/inference-gateway`) is already an adapter-pattern proxy
(`router.ts` + `adapters/*.ts`, "routes requests to any model backend via swappable
adapters") — adding OpenRouter there is a new adapter, not a rewrite.

## Scope

**In scope:**
1. `OpenRouterAdapter` in `inference-gateway`, wired into the router
2. Real wiring: picking a model in the web chat UI changes which model answers (not
   just a DB write with no downstream effect)
3. Per-conversation selection scope, reusing the existing `agent.llmProviderId` field
   and mutation
4. Static cost-tier badge ($/$$/$$$) in the picker, ranked client-side from
   `costPerToken` — no live estimate, no credits math
5. 3 curated OpenRouter model rows seeded as `status: 'coming_soon'` (no real API key
   yet — flipping to `'live'` is a one-row update once a key is added)
6. Actually rendering the picker UI in `ChatInput.tsx`

**Explicitly out of scope:**
- A real `OPENROUTER_API_KEY` — stays an env placeholder, same pattern as `apps/api/.env`'s
  existing `FILL_IN` entries. Seeded rows are `coming_soon` until someone sets it.
- Per-message model switching (mid-conversation, turn by turn) — this ships
  per-conversation only, matching the existing `agent.llmProviderId` field's grain.
- Credits/usage ledger and any live per-message cost estimate — no usage-metered
  billing exists (subscription billing only); the cost badge is a static rank, not a
  number.
- Autonomy-mode selector ("Generate without asking" / etc.) — separate sub-project,
  unrelated mechanism.
- Admin UI for managing `llm_providers` rows beyond the seed script — `ops.providers.ts`
  already exists for provider-key management generally; extending it for full CRUD on
  this table is not part of this slice.
- Mobile WebSocket relay path — already wired (via `bundler.ts`); untouched here.

## Decisions

- **Extend, don't replace.** No new tables, no new routing mechanism — this plugs into
  the adapter pattern `inference-gateway` was already built for, and the `llmProviderId`
  field that already exists on `agents`.
- **Restricted-data override is non-negotiable.** `privateModel` (CASA/KYC data, never
  leaves infra) wins over any user-selected model unconditionally.  A user picking
  "Claude Opus 5" does not override the guardrail that keeps restricted-sensitivity
  conversations on the local Ollama backend.
- **No fallback chain for OpenRouter.** The existing Vertex/Gemini chain falls back
  through multiple adapters because the model choice wasn't user-visible. Here the user
  explicitly picked a model; silently answering with a different one on failure is worse
  than a visible error. `getAdapterChain()` returns `[openrouterCB]` only.
- **Seed as `coming_soon`, not `live`.** Since there's no real API key yet, shipping
  these rows as selectable-but-broken would be a worse experience than shipping them
  visible-but-disabled. `status` already exists for exactly this.
- **Cost tiers computed client-side by ranking, not hardcoded thresholds.** Avoids
  inventing dollar cutoffs that need retuning every time a model is added.
- **Fail open to current behavior.** If the provider lookup in `chatStream.ts` finds no
  row, a `coming_soon` row, or errors, it falls back to today's fixed
  `platformModel`/`liteModel` selection. An agent that never touches the picker sees no
  behavior change.

## Design

### 1. `inference-gateway` — new adapter

`apps/inference-gateway/src/adapters/openrouter.ts` (new file), following the existing
adapter shape (see `adapters/anthropic.ts` for the closest analog — cloud API, not
local like Ollama):

- Implements `ProviderAdapter` (`handleCompletion(req, res)`).
- OpenAI-compatible passthrough to `https://openrouter.ai/api/v1`.
- Auth: `Authorization: Bearer ${process.env.OPENROUTER_API_KEY}`. If unset, throws
  `AdapterError(503, 'openrouter_not_configured')` immediately (no network call) — this
  is the expected state until a key is added; the `coming_soon` status on seeded rows
  means the frontend won't let a user reach this path anyway, but the adapter must fail
  safely if something calls it directly (e.g. Mastra Studio).
- Adds OpenRouter's recommended attribution headers (`HTTP-Referer`,
  `X-Title: project-context`) — optional per OpenRouter's docs but free to include and
  affects their leaderboard/rate-limit treatment.
- Strips the `openrouter/` prefix from the incoming model string before forwarding
  (gateway-internal routing prefix, not part of OpenRouter's own model slug).

`apps/inference-gateway/src/router.ts`:
- New `openrouterAdapter` + `openrouterBreaker` (`CircuitBreaker('openrouter', {
  failureThreshold: 5, resetTimeoutMs: 60_000 })`, matching the Gemini breaker's
  shape) + `openrouterCB`.
- New rule in `getAdapterChain()`: `if (m.startsWith('openrouter/')) return
  [openrouterCB]` — checked before the `claude-*`/`ollama/*`/default rules, same
  position style as the existing `ollama/*` early-return.
- Update the file's routing-rules doc comment to list the new prefix.

`apps/inference-gateway/.env.example`: add `OPENROUTER_API_KEY=` (empty, documented
placeholder).

### 2. Mastra model resolution

`apps/agent-orchestrator/src/mastra/model.ts`:
- Add `export function resolveModel(modelString: string) { return gateway(modelString)
  }` — thin wrapper exposing the existing `gateway` factory (currently only used to
  build the three module-level constants) so callers can build a model connector from
  an arbitrary string at request time.

`apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`, the dynamic `model`
function (currently: restricted → thinkingBudget → default):
```
model: ({ requestContext }) => {
  const sensitivity = requestContext?.get('maxDataSensitivity')
  if (sensitivity === 'restricted') return privateModel   // non-negotiable, checked first

  const selectedModel = requestContext?.get('selectedModel') as string | undefined
  if (selectedModel) return resolveModel(selectedModel)

  const budget = requestContext?.get('thinkingBudget')
  return budget === 0 ? liteModel : platformModel
}
```
A user's explicit model selection takes precedence over the thinking-budget lite/full
split (they asked for a specific model; that's a stronger signal than the budget
heuristic), but never over the restricted-data guardrail.

### 3. Wiring the selection into a request

`apps/agent-orchestrator/src/routes/chatStream.ts`, near where `tenantId`/`agentId`
already get resolved and before the `requestContext.set(...)` block:

- Look up the conversation's agent's `llmProviderId` (already available — same place
  `agentSkill.systemPrompt` gets read for the per-agent prompt override).
- If set, `SELECT provider, model, status FROM llm_providers WHERE id = $1` via
  `makeAppPool` (`apps/agent-orchestrator/src/db.ts`), the same raw-SQL pattern
  `fetchPlatformPrompt()` already uses — no new DB dependency.
- If the row exists and `status === 'live'`, build the gateway model string
  (`openrouter/${model}` for `provider === 'openrouter'`; existing providers keep their
  current string shape) and `requestContext.set('selectedModel', modelString)`.
- Any other outcome (no `llmProviderId`, no row, `status !== 'live'`, query error):
  don't set `selectedModel` — falls through to today's default behavior. Log a warning
  on query error only (not on the common "no selection made" case).

### 4. Backend: exposing cost data

`products/agent-platform/packages/api/routes/llm-providers.ts`: add `costPerToken` to
the select and the response mapping (currently selected columns omit it).

### 5. Frontend: the picker

`apps/web/app/[tenant]/dashboard/chat/useChatPage.ts`: add `costPerToken: string | null`
to the local `LLMProvider` interface (mirrors the route's new response field).

`apps/web/components/platform/chat/ChatInput.tsx`:
- Render a picker using the `DropdownMenu`/`DropdownMenuTrigger`/`DropdownMenuContent`/
  `DropdownMenuItem` primitives already imported in this file (no new UI dependency),
  placed next to the existing "Use employee" button.
- Trigger shows the current provider's `displayName` (fall back to "Model" if
  `llmProviderId` is unset).
- Each item: `displayName` + a cost badge computed by ranking all `providers` by
  `costPerToken` ascending and bucketing into thirds → $ / $$ / $$$ labels (rows with a
  null `costPerToken` render with no badge). Ranking, not fixed thresholds, per the
  Decisions section.
- Items with `status !== 'live'` render disabled with a small "Coming soon" suffix, not
  clickable.
- Selecting a live item calls the existing `onModelChange` prop unchanged — no new
  mutation needed, `useChatPage.ts`'s `updateAgentMutation` already handles persisting
  `llmProviderId`.

### 6. Seed data

New `products/agent-platform/packages/api/seeds/llm-providers-openrouter.ts` (same
shape/idempotency pattern as `seeds/agent-templates.ts`: connects via `DATABASE_URL`,
upserts by a stable key rather than blind-inserting), seeding 3 platform rows
(`isPlatform: true`, `tenantId: null`, `status: 'coming_soon'`):

| displayName | provider | model | costPerToken (relative) |
|---|---|---|---|
| Claude Opus 5 | openrouter | `anthropic/claude-opus-5` | high |
| GPT-5.1 | openrouter | `openai/gpt-5.1` | mid |
| Gemini 2.5 Flash (OpenRouter) | openrouter | `google/gemini-2.5-flash` | low |

Model slugs are best-effort based on OpenRouter's existing naming convention
(`vendor/model`); they should be verified against OpenRouter's live catalog once a real
API key is available, before flipping status to `'live'`. Exact `costPerToken` values
need the same verification — the table above just needs to preserve high/mid/low
ordering for the tier badge to render sensibly.

## Error handling

- No `OPENROUTER_API_KEY` set + adapter reached anyway (shouldn't happen via the UI
  since rows are `coming_soon`, but reachable via Mastra Studio / direct API testing):
  adapter fails fast with a clear `AdapterError`, no network call attempted.
- `chatStream.ts` provider lookup failure (bad `llmProviderId`, DB error, row deleted
  after being selected): falls back to default model selection, never blocks or errors
  the turn.
- OpenRouter API error mid-stream (once a real key exists): same `AdapterError` path as
  every other adapter; no fallback chain means the user sees a normal chat error
  message rather than a silent model substitution.

## Testing

- `inference-gateway`: unit tests for `OpenRouterAdapter` (request shape, header
  translation, missing-key fast-fail) with mocked `fetch`, and a `router.ts` test
  confirming `openrouter/*` model strings select the right chain — same style as
  existing adapter/router tests in this package.
- `agent-orchestrator`: unit test for `resolveModel` and for `platformAgent`'s model
  function precedence (restricted > selected > thinkingBudget), reusing the mocked
  `requestContext` pattern already used in `askClarifyingQuestions.test.ts`.
- `messages.ts`/`llm-providers.ts` route: extend existing route tests for the new
  `costPerToken` field if a test file already covers this route; otherwise skip (no
  precedent to extend).
- Frontend: no automated test — matches this codebase's existing convention (no test
  files for `ChatInput`/`SlashPalette`/`MentionPalette`). Manual dev-server pass:
  picker renders, disabled items don't select, `onModelChange` fires and persists via
  the existing mutation, cost badges render in a sensible order.
