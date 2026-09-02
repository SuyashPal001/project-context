# Producer agent — instrumental song generation

Date: 2026-09-03

## Summary

New official, user-facing agent, "Producer," that generates a short
instrumental music clip from a text prompt via Vertex AI Lyria, synchronously,
inline in chat. This extends the pattern shipped for
[Director](2026-09-01-director-agent-image-generation-design.md) (image
generation) to a third modality (audio), following the extensibility the
[media-generation planning doc](../../media-generation/README.md) called for,
without adopting that doc's unbuilt unified `/v1/generations` envelope —
Director shipped as a dedicated `/v1/images/generations` route, so this
follows that precedent (`/v1/music/generations`) rather than the doc's
original, superseded design.

**Scope correction from the initial ask.** Verified against Vertex AI docs
2026-09-03: two Lyria tiers exist. `lyria-002` is GA, unrestricted, and
produces ~30-second instrumental clips with no vocals and no song structure
(verse/chorus/bridge). `lyria-3-pro-preview` (up to ~184s, with vocals, timed
lyrics, and structure — an actual song) also exists on Vertex, but is preview
and gated behind a manual Google allowlist request per GCP project, with no
published approval timeline — confirmed via multiple open requests on
Google's developer forum. This spec targets `lyria-002` so it ships without
waiting on a third party's approval; `lyria-3-pro-preview` is a follow-up
swap once/if the project is allowlisted (see §4's model-id note). Until then,
this ships instrumental-only under an honest name and honest tool
description, not a simulated "song."

## Goals

- Add a Producer persona/agent to the built-in roster (same tier as Disco,
  PM Agent, Architect, Director).
- User asks Producer for a piece of instrumental music (mood/genre/style
  prompt) and gets an audio clip inline in the chat turn.
- Charge each generation at its actual cost, mirroring Director's per-call
  credit model — not folded into the flat per-chat-turn rate.

## Non-goals

- Vocals, lyrics, or multi-section song structure — not a Lyria capability.
  Not simulated by prompt engineering in this spec.
- Video generation — separate, already-deferred track per the media-generation
  doc.
- Editing/remixing an existing generated clip (Director's `edit_image`
  equivalent) — no Lyria capability for this; not attempted.
- A full audio player/waveform UI — v1 ships through the existing attachment
  strip mechanism (see §7); a richer player is a follow-up if the default
  rendering proves inadequate.

## Design

### 1. Persona + agent registration (same four rosters as Director)

Director's spec found four places that must all agree or the agent exists on
some paths and not others. Confirmed still current; replicate exactly:

1. **`products/agent-platform/packages/api/seeds/personas.ts`** —
   `DEFAULT_PERSONAS`. Add a `producer` entry (slug `producer`, name
   `Producer`), same shape as the existing `director` entry. Seeded
   `is_official: true`, `status: 'draft'`.
2. **`apps/api/src/routes/onboarding.ts`** — add a "Producer Agent" block
   mirroring the Director block at line 354 (persona lookup by slug, API key,
   `agents` row with `personaId` set to the seeded Producer persona's id,
   `type: 'assistant'` — same reasoning as Director, no existing `type` value
   fits "generates music" either).
3. **`packages/foundation/database/seeds/backfill-agents.ts`** — add a
   Producer entry (`name: 'Producer'`, `systemPrompt: 'You are Producer.
   Generate instrumental music from a description.'`,
   `personaSlug: 'producer'`) for tenants that predate this agent.
4. **`apps/agent-orchestrator/src/mastra/registry.ts`** — add
   `producer: producerAgent` to `AGENT_REGISTRY`, a `resolveAgentLabel`
   branch, and a `DEFAULT_AGENTS` display entry (`name: 'Producer',
   description: 'Generates instrumental music'`).

**Publishing.** Same manual ops gate as Director: seeding leaves the persona
`status: 'draft'`; making it selectable requires attaching a real preview
asset via `PUT /ops/personas/:id` then `POST /ops/personas/:id/publish`. Call
this out as a required manual step after deploy, not part of the
implementation plan.

### 2. Mastra agent

New file `apps/agent-orchestrator/src/mastra/agents/producerAgent.ts`,
structured identically to `directorAgent.ts`:

```ts
new Agent({
  id: 'pc-producer',
  name: 'Producer',
  description: 'Generates instrumental music clips from a text description.',
  instructions: async ({ requestContext }) => { ... },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { generate_song: generateSong },
})
```

Single tool, no sub-agents — same shape as Director minus `edit_image` (no
edit capability exists for this modality, see Non-goals).

**Instructions must set honest expectations up front**, mirroring Director's
refusal-handling block:
- Call `generate_song` for a new instrumental clip from a mood/genre/style
  description.
- This produces a short (~30s) instrumental piece — **no vocals, no lyrics,
  no verse/chorus structure**. If the user asks for a "song" with singing or
  lyrics, tell them plainly that's not supported yet, before attempting a
  generation, not after a charge lands.
- Before claiming a clip is ready, check the tool result for a `fileId` field
  — same pattern as Director's image check.
- Refusal-reason handling mirrors Director's (`GENERATION_FAILED`,
  `STORAGE_FAILED`, safety refusal, `insufficientCredits`) — see §3.

### 3. Tool

New file `apps/agent-orchestrator/src/mastra/tools/generateSong.ts`, same
shape as `generateImage.ts` (`renderCanvas.ts`-style: pull
`conversationId`/`idToken`/`tenantId`/`agentId` off `execContext.requestContext`,
call gateway, charge, upload, return metadata):

```ts
outputSchema: z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})
```

Bytes never enter the return value — same reasoning as Director: they'd
otherwise get replayed into every later turn via Mastra's per-tenant memory.

**Charge-after-success**, matching Director's settled design (not
pre-charge): call the gateway first; charge only on a non-refused response
with actual audio bytes present; refund on a post-charge storage failure. Use
the same `spendCredits`/`InsufficientCreditsError` pattern as
`generateImage.ts`, under a new `jobType: 'music_generation'`.

**Timeout.** `AbortSignal.timeout(90_000)` on the gateway call — same bound
Director uses. Lyria's generation cost is lower per call than image/video, so
this should be conservative in practice; revisit only if real latency proves
otherwise.

**No retry ladder** — same reasoning as Director (§3 of that spec): a
billable generation call gets at most one retry on a clear transient failure,
never on a refusal.

### 4. Inference gateway

New file `apps/inference-gateway/src/music.ts`, structurally identical to
`images.ts`:

- `MUSIC_MODEL_ALLOWLIST` — single entry: `lyria-002`. Confirmed GA, no
  Google-side allowlist needed, region `us-central1` (regional, not
  global-endpoint-only like the image models — no special-cased hostname
  branch needed here, unlike `images.ts`'s `LOCATION` handling).
- Lyria's Vertex API shape is `:predict`
  (`https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models/lyria-002:predict`),
  not `:generateContent` — closer to Imagen's contract than to Gemini's
  chat-style image gen. The adapter (`callVertexMusicModel`) builds a
  predict-shaped request/response, not a copy of `buildGeminiImageRequest`.
  Output: WAV, 48kHz, ~30s, per Google's docs — confirm exact response field
  name during implementation.
- **Future upgrade path, not this spec's scope:** `lyria-3-pro-preview`
  supports real songs (vocals, timed lyrics, verse/chorus/bridge structure,
  up to ~184s) but requires a manual Google allowlist request with no
  published SLA, and uses a different wire shape entirely
  (`generateContent` with `response_modalities: ["AUDIO", "TEXT"]`, vocals/
  lyrics passed as plain prompt text — no dedicated parameters). If/when
  allowlisted, swapping to it is a new adapter and a new model-allowlist
  entry, not a parameter change to this one.
- New route `POST /v1/music/generations` in `apps/inference-gateway/src/index.ts`,
  handled directly (same pattern as the existing images route). Request body:
  `{ model, prompt }`. Response body: `{ audioBase64, mimeType }` on success,
  or `{ refused: true, reason }` on a safety block — classification happens
  in the route, same as images.
- **No Ollama fallback** — Ollama cannot generate audio and doesn't know the
  model name. Dedicated circuit breakers (`vertexMusicBreaker`), no
  cross-adapter chain, same isolation reasoning as the image breakers
  (`router.ts`'s comment on why image breakers are separate from chat
  breakers applies identically here — a music generation failure must not
  trip the chat model's circuit).
- **No cross-vendor substitution** — per the media-generation doc's settled
  rule. If Vertex Lyria is down, this is a clean 503, not a silent fallback
  to a different vendor's model.
- Safety settings: reuse the same `SAFETY_SETTINGS` block `images.ts`
  defines, if Lyria's predict API accepts a `safetySettings` field — verify
  during implementation; if it doesn't, note that gap rather than silently
  dropping content moderation.
- Request size cap: prompt-only request, no binary upload in the request
  direction — the existing `readBody` size cap (added for Director's
  `editImage` payload) already covers this; no new cap needed.

### 5. Storage

No new work — `uploadGeneratedFile` (`apps/agent-orchestrator/src/persistence.ts`)
is already generalized for binary content (`content: string | Buffer`,
`contentType`, `extension`) as part of Director's implementation. Call it with
`contentType: genResult.mimeType` (likely `audio/wav` or `audio/mpeg`,
whichever Lyria returns) and a matching `extension`.

**Quota applies identically to Director's finding** — the tenant storage
quota consumes on generated audio same as generated images, and a
post-generation quota rejection must not leave the user charged for a clip
they can never retrieve (refund path in §3, same trigger as Director's §5/§6).

### 6. Credits

New `credit_rates` row: `resource_type: 'music_generation'`, `subject:
<lyria-model-id>`, pricing schema `{ per_call_micro: <rate> }` — same
mechanism Director used, no new `@serverless-saas/credits` machinery. Rate
value is a business decision, flagged for whoever owns pricing, not invented
here.

New sibling file `apps/agent-orchestrator/src/mastra/tools/musicCredits.ts`
(`refundMusicCharge`), rather than generalizing `imageCredits.ts` — mirrors
this repo's existing "two homes deliberately" convention (see CLAUDE.md's
credit-code note) of not collapsing per-modality credit helpers into one
shared abstraction prematurely. Same read-back-from-ledger /
shortest-expiry-wins refund pattern as `refundImageCharge`.

### 7. Attachment delivery

`chatStream.ts`'s tool-result gate (`normalizedToolName` allowlist at line
133, and `SAVE_TOOL_NAMES` at line 209) currently only recognizes
`render-canvas`, `generate-image`, `edit-image`. Add `generate-song` to both
sets, or the tool result is silently dropped — this is the exact gap
Director's spec found and fixed for images; it recurs for every new
generation-producing tool name.

On the web side, `AttachmentStrip.tsx` renders any attachment with a
`fileId`/`type` — check whether its thumbnail path assumes an image
(`useThumbnailUrl`) or degrades sensibly for an audio MIME type. If it does
not already render a usable control for `audio/*`, v1 should at minimum show
a filename/download affordance rather than a broken thumbnail; a proper
inline audio player is a reasonable follow-up, not a blocker for v1.

### 8. Deployment

Same restart/deploy surface as Director, replicated:

- `apps/agent-orchestrator` changes (agent, tool, `chatStream.ts`,
  `registry.ts`) require `pm2 restart agent-orchestrator`.
- `apps/inference-gateway` changes require `pm2 restart inference-gateway`.
- `apps/api/src/routes/onboarding.ts` changes go through `sam deploy` —
  rebuild `packages/foundation/*` / product `dist/` first (stale-`dist/`
  footgun).
- `packages/foundation/database/seeds/backfill-agents.ts` and
  `products/agent-platform/packages/api/seeds/personas.ts` are one-time
  scripts, run manually after deploy.

## Tradeoffs

- **Instrumental-only, no vocals/lyrics/structure.** Accepted scope per the
  clarifying question — ships fastest, matches what Lyria actually does. A
  full-song vendor is a distinct future spec if this proves insufficient.
- **Synchronous, not job-queued.** Same latency reasoning as Director (§7 of
  that spec) — the browser talks directly to the agent-orchestrator host, not
  through API Gateway's 29s limit. Lyria's clips are short and generation
  should be fast; revisit if real-world latency proves otherwise.
- **Pricing deferred to implementation-time verification** (rate value is a
  business decision). Model id (`lyria-002`, GA, `:predict`, `us-central1`)
  is now confirmed — see §4.
- **Instrumental-only is a real capability gap, not just this spec's
  choice.** `lyria-3-pro-preview` (real songs, vocals) exists on Vertex today
  but is allowlist-gated with no published approval timeline — out of this
  spec's control, noted as a follow-up in §4.

## Testing

- Unit: `generateSong` tool `execute()` against a mocked gateway response —
  success (upload + charge), refusal (no charge), transient failure (refund),
  quota-exceeded upload failure (refund).
- Unit: gateway's new `/v1/music/generations` route — request shape, refusal
  classification, no-Ollama-fallback behavior when Vertex fails.
- Integration: Producer agent end-to-end through `chatStream.ts` with a
  recorded Lyria response — verifies the `music_generation` credit charge
  fires and the attachment survives the tool-name gate (§7) to reach the
  client payload.
- Manual: chat with Producer in dev, request an instrumental clip, confirm it
  round-trips through S3, appears in chat (even if only as a download
  affordance per §7), and debits the correct credit amount. Separately: ask
  for "a song with lyrics" and confirm Producer declines before charging,
  per §2's instructions requirement.
