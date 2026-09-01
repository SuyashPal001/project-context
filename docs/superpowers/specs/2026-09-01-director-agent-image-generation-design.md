# Director agent — image generation & editing

Date: 2026-09-01 (rev 2 — folds in Opus review findings)

## Summary

New official, user-facing agent, "Director," that generates and edits images
via Gemini 3 Pro Image (`gemini-3-pro-image-preview`), synchronously, inline
in chat. Video generation (Gemini Omni Flash) is explicitly deferred — not in
this spec.

**Revision note:** rev 1 of this spec was reviewed and found to
mischaracterize the credit charge (claimed flat, actually near-zero for
image turns), omit required changes to `chatStream.ts` (attachments would be
silently dropped), assume `uploadGeneratedFile` works unmodified for binary
content (it's markdown-only), and miss that tenant onboarding does not seed
agents through the registry this spec extends. All fixed below. Sections
kept from rev 1 are marked unchanged; the rest is new or corrected.

## Goals

- Add a Director persona/agent to the built-in roster (same tier as Disco,
  PM Agent, Architect).
- User asks Director for an image (text-to-image) or to edit an existing
  image (edit-in-place), and gets a result inline in the chat turn.
- Charge each generation at its actual cost, not folded into the flat
  per-chat-turn rate.

## Non-goals

- Video generation (Gemini Omni Flash) — future spec.
- Async/job-queued generation — deferred (latency analysis in §7 below
  supports staying synchronous).
- A full-size image viewer in the web app — v1 ships through the existing
  attachment strip (80×80 thumbnail); a larger viewer is a follow-up if the
  thumbnail proves too small in practice.

## Design

### 1. Persona + agent registration (revised — four rosters, not one)

There are four places agent/persona definitions live, and they have already
drifted from each other (`onboarding.ts` seeds a "Tech Lead" agent that
appears in neither of the other two lists). Director must be added to all
four or it will exist in some paths and not others:

1. **`products/agent-platform/packages/api/seeds/personas.ts`** —
   `DEFAULT_PERSONAS`. Add a `director` entry, same shape as
   `disco`/`pm`/`architect` (slug, name, tagline, basePersonality,
   skillTags). Seeded `is_official: true`, `status: 'draft'`.
2. **`apps/api/src/routes/onboarding.ts`** — this is what actually runs for
   a new tenant (Lambda; cannot import the orchestrator's `registry.ts`).
   Add a "Director" entry to whatever inline list it hand-rolls agent rows
   from (API key + `agents` row + `agentSkills` row), matching the shape of
   the existing Disco/PM Agent/Architect/Tech Lead entries there. Give it
   `type: 'assistant'` (existing values in that file: `assistant`, `pm`,
   `tech_lead`, `architect` — none of those fit "generates images," so
   `assistant` is the closest existing bucket; do not invent a new `type`
   value without checking whether anything switches on it).
3. **`packages/foundation/database/seeds/backfill-agents.ts`** — its own
   `DEFAULT_AGENTS` (different shape: `systemPrompt` instead of Mastra
   wiring), used to backfill agents for tenants that predate a new default
   agent. Add Director here too, for existing tenants. This file already
   holds product-specific agent names in a foundation package — that's a
   pre-existing boundary violation, not one this spec introduces; note it
   in the PR description rather than "fixing" it as a drive-by.
4. **`apps/agent-orchestrator/src/mastra/registry.ts`** — `AGENT_REGISTRY`
   (`'director' → directorAgent`) and `DEFAULT_AGENTS` (display list only;
   confirmed NOT what onboarding actually seeds from — the header comment
   there is stale and should be corrected while touching the file).

**Persona ↔ agent linkage.** Today, nothing in `onboarding.ts` sets
`personaId` on the `agents` row it creates — this matches the known
"personaId-NULL agents run with zero personality" gap. This spec does not
fix that gap generally, but Director's onboarding entry (#2 above) MUST set
`personaId` to the seeded Director persona's id, so Director does not ship
into the same broken state on day one. This requires the persona to be
seeded (or seedable at onboarding time) before the agent row is created —
sequence the onboarding change accordingly.

**Publishing.** The persona `status: 'draft'` → `published` gate requires
`exampleAssetUrl` (`POST /ops/personas/:id/publish`'s `INCOMPLETE_ASSETS`
check) — rev 1 incorrectly implied `PersonaAvatar`'s generated SVG
satisfies this; it doesn't, `PersonaAvatar` is a render-time fallback, not a
stored asset. Publishing Director (making it selectable in the roster) is a
manual ops step after seeding: attach a real preview image via
`PUT /ops/personas/:id`, then `POST /ops/personas/:id/publish`. Out of
scope for the implementation plan itself; call it out as a required manual
step after deploy.

### 2. Mastra agent (unchanged from rev 1)

New file `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`,
structured like `pmAgent.ts`:

```ts
new Agent({
  id, name, description,
  instructions: async ({ requestContext }) => { ... },
  requestContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { generateImage, editImage },
})
```

No sub-agents — Director does not delegate to other Mastra agents.

### 3. Tools (revised — pattern, output shape, source-image resolution)

Two new tool files under `apps/agent-orchestrator/src/mastra/tools/`:
`generateImage.ts`, `editImage.ts`.

**Pattern to follow is `renderCanvas.ts`, not `fetchAgentContext.ts`** (rev
1 pointed at the wrong precedent) — `renderCanvas.ts` is the only existing
tool that generates content, uploads it, and returns an attachment, and it
shows the exact mechanics: pulling `conversationId`/`idToken` off
`execContext.requestContext`, calling the upload helper, and returning
`{ ...primaryFields, fileId, name, fileType, size }` conditionally on the
upload having succeeded.

**Output schema returns metadata only, never image bytes:**

```ts
outputSchema: z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
})
```

Bytes are handled entirely inside `execute()` (gateway call → upload) and
never enter the return value. If bytes were returned, they'd get written
into Mastra's per-tenant `PostgresStore` memory and re-sent to the model on
every later turn in the conversation — cost and latency blowup on every
subsequent message, not just this one.

**`editImage` source-image input is `fileId`, not a URL.** Rev 1 left this
as "URL/attachment id already in the conversation" — too vague, and "URL"
specifically invites an SSRF-shaped fetch of arbitrary hosts from the VM.
Input schema takes `sourceFileId: z.string()`, resolved through
`downloadMediaAttachment` (`apps/agent-orchestrator/src/media.ts`), which
already enforces tenancy-scoped access to the file before returning bytes.

**Refusal handling.** Gemini can return a safety block / `finishReason:
SAFETY` / an empty candidate instead of image bytes. `execute()` must treat
that as a normal, non-throwing outcome: return `{ refused: true,
refusalReason }` (a short, user-safe string — not the raw provider
response) rather than throwing, so the agent can tell the user plainly
instead of surfacing a tool-call error. A refusal must not be charged (see
§6) and must not be retried.

**Timeout.** The gateway call carries `AbortSignal.timeout(90_000)`. No
backoff-retry ladder (the `geminiExtract.ts` four-attempt/backoff pattern is
appropriate for cheap extraction calls, not for a billable image render) —
at most one retry, only on a clear transient failure (network error / 5xx),
never on a safety refusal.

### 4. Inference gateway (revised — concrete wire format, no Ollama fallback)

Rev 1 said "extend `vertex.ts` to accept `generationConfig.imageConfig`,"
which doesn't fit the existing wire format: `OpenAIRequest` has no
`generationConfig` field, and `OpenAIChoiceMessage.content` is
`string | null` — there's no slot for returned image bytes in the
chat-completions shape every other caller and adapter is built around.

**Concrete decision: new route, not an extension of the chat-completions
path.** Add `POST /v1/images/generations` in
`apps/inference-gateway/src/index.ts`, handled directly (similar to the
existing `handleNativeGemini` raw-passthrough path at `index.ts:197`, which
already speaks native Gemini request/response shape). Request body:
`{ model, prompt, sourceImageBase64?, safetySettings? }`. Response body:
`{ imageBase64, mimeType }` on success, or `{ refused: true, reason }` on a
safety block — the route itself classifies the Gemini response rather than
pushing that logic into every caller.

**No Ollama fallback for image models.** `getAdapterChain` in
`apps/inference-gateway/src/router.ts` currently routes any `gemini-*`
model through `[vertex, gemini, ollama]`. Ollama cannot generate images and
doesn't know the model name — if both Vertex and the Gemini API-key
fallback fail, the request would silently reach a local text model. Special
case `gemini-3-pro-image-preview` (and any future image model) to
`[vertexCB, geminiCB]` with no Ollama tail; if both fail, return a clean 503
rather than falling through.

**Safety settings.** Neither `vertex.ts` nor `gemini.ts` currently sets
`safetySettings` anywhere — image gen runs on provider defaults today. The
new route sets explicit `safetySettings` on the outbound Gemini/Vertex
call (block thresholds TBD by whoever owns content policy — flag this as a
decision needed before merge, not a default to invent silently).

**Request size cap.** `readBody` in `index.ts` currently reads the request
body with no size limit (`data += chunk`, unbounded). `editImage` sends a
base64-encoded source image, which is already a heavier payload than
today's callers produce. Add an explicit byte cap to `readBody` (return 413
over it), and cap the source image's byte size in `editImage`'s Zod input
schema before it's even sent.

`GEMINI_API_KEY` fallback path (`gemini.ts`) gets the same image-model
support as `vertex.ts`, so the fallback isn't silently narrower than
primary.

### 5. Storage (revised — `uploadGeneratedFile` needs generalizing, quota applies)

`uploadGeneratedFile` (`apps/agent-orchestrator/src/persistence.ts`) is
markdown-only today: hardcoded `${title}.md` filename, hardcoded
`text/markdown` content type, `content: string` body,
`Buffer.byteLength(content)` on a string. None of that works for PNG bytes
as-is — this is new work, not pure reuse as rev 1 framed it.

Generalize the function's signature to accept binary content:

```ts
uploadGeneratedFile(idToken, {
  conversationId,
  title,
  content: string | Buffer,
  contentType?: string,   // defaults to 'text/markdown' for back-compat
  extension?: string,     // defaults to 'md'
})
```

`generatedFileKey()` needs the same `extension` parameterization (currently
unconditionally appends `.md`). The 3-hop flow itself (mint pending row →
`PUT` presigned URL → confirm, through the main API's `/files` routes) is
unchanged and is genuinely reused as-is.

**Quota interacts with this.** `decideUpload`/`resolveStorageLimit`
(`apps/api/src/routes/files.ts`) apply the tenant's storage quota
(500MB/file, 20GB free tier) to every upload, generated images included.
Two consequences worth stating up front rather than discovering in
production: images will consume quota meaningfully faster than markdown
canvases ever did, and if the upload is rejected for quota, it happens
*after* the (paid) generation already ran — the tool must surface that as a
clear "generated but couldn't save (storage full)" message rather than a
silent `null`, and must not charge for a generation whose result the user
can never retrieve (tie this into the refund path in §6).

### 6. Credits (revised — dedicated per-call charge, not the flat chat-turn rate)

**Rev 1's premise was wrong and is corrected here.** `debitChatTurn` is
token-metered off the *chat* model's usage (`inputTokens`/`outputTokens`
from the Mastra `finish` event), not flat, and those numbers never include
an image tool's own out-of-band `fetch` to the gateway. In practice, an
image-generation turn would be billed only for the surrounding chat text —
a few hundred tokens — meaning image generation is effectively **free**,
not "the same as a text turn" as rev 1's tradeoff claimed.

**Design: charge the image call directly, inside the tool, before calling
Gemini.** This follows the existing `chargeTaskEstimate` pattern
(`apps/agent-orchestrator/src/credits.ts:229`), where the `spendCredits()`
call itself *is* the balance check (it throws `InsufficientCreditsError`
under the account lock if the balance can't cover it) — not a separate
pre-check that concurrent requests could each pass independently, which is
exactly the race `debitChatTurn`'s balance>0 pre-check has and
`chargeTaskEstimate` deliberately avoids.

- New `credit_rates` row: `resource_type: 'image_generation'`,
  `subject: 'gemini-3-pro-image-preview'`, pricing schema
  `{ per_call_micro: <rate> }` (flat per call — `costMicro` already
  supports this schema; no change needed to `@serverless-saas/credits`).
  Rate value is a business decision, not an engineering one — flag for
  whoever owns pricing before merge.
- `execute()` in `generateImage.ts`/`editImage.ts` calls
  `resolveRate('image_generation', 'gemini-3-pro-image-preview')`, then
  `spendCredits({ tenantId, amountMicro: -cost, key: `image:${sessionId}:${n}`,
  kind: 'debit', actorId: agentId, actorType: 'agent', rateId, rateVersion,
  jobType: 'image_generation' })` **before** calling the gateway. Unlimited
  tenants (`isUnlimited(tenantId)`) skip the charge, matching
  `chargeTaskEstimate`'s handling.
- If `spendCredits` throws `InsufficientCreditsError`, the tool returns a
  clear "not enough credits" result to the user — no generation attempted,
  nothing to refund.
- If the charge succeeds but the Gemini call then fails (transient error,
  not a safety refusal) or the storage upload fails (§5's quota case),
  refund the same idempotency key via `spendCredits` with a positive
  `amountMicro` and `kind: 'debit'` reversal (mirroring `settleTask`'s
  delta-write pattern) — the user should not pay for a generation they
  never received.
- A safety refusal (§3) is *not* charged at all: check for refusal in the
  gateway response before treating the charge as final, or charge only
  after a successful non-refused response comes back. (Simpler: call the
  gateway first, charge only on success. Revisit whether pre-charging is
  needed at all if abuse via free-refusal-spam turns out not to be a real
  risk — start with charge-after-success, add pre-charging only if
  needed.)

This is one new `credit_rates` row and one new call site per tool — not new
credit machinery in the sense of new tables or new core functions.

### 7. Latency, timeout, and the sync-vs-queued call (new section)

Confirming the sync decision from rev 1, with the actual constraint
identified: the browser talks directly to the agent-orchestrator's own
host (`apps/web/hooks/useAgentEvents.ts`), **not** through API Gateway, so
the Lambda/API-Gateway 29s timeout does not apply to this path, and the
existing SSE tool-call heartbeat keeps the connection alive during a long
tool call. Synchronous is reasonable on that basis.

Two things to add rather than leave implicit:
- Hard `AbortSignal.timeout(90_000)` on the gateway fetch (§3), so a hung
  Gemini call can't hang the turn indefinitely.
- Whatever reverse proxy sits in front of the agent-orchestrator's public
  hostname (not part of this repo) needs its own read timeout checked
  against this — call this out as a deploy-time verification step, not
  something the plan can fix in code.

### 8. Attachment delivery (new section — closes the biggest gap in rev 1)

Rev 1 assumed the tool's returned attachment would "render inline, same as
any other chat attachment." It would not have: `chatStream.ts` currently
gates tool-result attachment handling with
`if (normalizedToolName !== 'render-canvas') return null` — any other tool
name's result, including `generate-image`/`edit-image`, is dropped
entirely. This must change:

- `chatStream.ts`'s tool-result handling needs `generate-image` and
  `edit-image` added alongside `render-canvas` in that check (and in
  `SAVE_TOOL_NAMES`, which controls what gets persisted to the
  conversation).
- On the web side, `AttachmentStrip.tsx` already renders any attachment
  with a `fileId`/`type` as an 80×80 cropped thumbnail via
  `useThumbnailUrl` — no code change required for v1 to *display*
  something, but be explicit with the user that this means a generated
  image ships as a small cropped thumbnail, not a full-size inline image,
  until a follow-up adds a proper image-attachment view.

### 9. Deployment (new section)

None of this reaches users through `./deploy.sh` alone:

- `apps/agent-orchestrator` changes (agent, tools, `chatStream.ts`,
  `persistence.ts`) require `pm2 restart agent-orchestrator` on the VM.
- `apps/inference-gateway` changes require `pm2 restart inference-gateway`
  (also VM-manual per CLAUDE.md).
- `apps/api/src/routes/onboarding.ts` changes go through a Lambda deploy
  (`sam deploy`) — rebuild `packages/foundation/*` / product `dist/` first,
  per the known stale-`dist/` footgun.
- `packages/foundation/database/seeds/backfill-agents.ts` and
  `products/agent-platform/packages/api/seeds/personas.ts` are one-time
  scripts, run manually after deploy, not part of the automated pipeline.

## Tradeoffs

- **Synchronous, not job-queued.** Confirmed reasonable given §7's finding
  that the 29s API-Gateway limit doesn't apply on this path. Revisit if
  real-world Gemini image latency proves worse than expected.
- **Pricing decision deferred.** The `per_call_micro` rate value for
  `image_generation` and the exact `safetySettings` thresholds are
  business/policy calls, not engineering ones — both need an owner before
  merge, flagged rather than defaulted.
- **v1 ships thumbnail-only image display.** Accepted for scope; a larger
  viewer is explicitly deferred, not accidentally missing.

## Testing

- Unit: `generateImage`/`editImage` tool `execute()` against a mocked
  gateway response — covers success (upload + charge), refusal (no charge,
  clear user message), transient failure (refund path), and quota-exceeded
  upload failure (refund path).
- Unit: gateway's new `/v1/images/generations` route — request shape,
  refusal classification, no-Ollama-fallback behavior when both Vertex and
  the Gemini key fail.
- Integration: Director agent end-to-end through `chatStream.ts` with a
  recorded Gemini image response — verifies the `image_generation` credit
  charge fires (not `debitChatTurn`'s token-metered charge, which this spec
  now correctly treats as unrelated), and the attachment survives the
  `chatStream.ts` tool-name gate and reaches the client payload.
- Manual: chat with Director in dev, request an image, then request an
  edit to it referencing the first by `fileId`; confirm both round-trip
  through S3, appear in chat, and debit the correct credit amount.
  Separately: force a safety-refusal prompt and confirm no charge lands.
