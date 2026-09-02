# Director agent — video generation via Gemini Omni Flash

Date: 2026-09-03

## Summary

Extends [Director](2026-09-01-director-agent-image-generation-design.md)
(already generates/edits images) with a `generate_video` tool backed by
Gemini Omni 1.1 Flash (`gemini-omni-1.1-flash`), synchronously, inline in
chat. This supersedes the media-generation doc's original Phase 2 plan
(Veo, async task queue) as the video vendor choice — Omni Flash is faster,
cheaper, conversational, and can edit/extend existing video, which Veo
cannot. Director owns this rather than a new agent, since video generation
is visually adjacent to Director's existing image work and reuses the same
persona/roster slot.

**Model id discipline.** Use `gemini-omni-1.1-flash` only — the GA id as of
2026-08-27. The older `gemini-omni-flash-preview` id is allowlist-gated and
scheduled for deprecation 2026-09-30; do not build against it.

## Goals

- Director generates a short video clip from a text prompt (text-to-video).
- Director edits/extends an existing video already in the conversation
  (video-to-video: extend, interpolate between frames, upscale resolution).
- Charge each generation at its actual cost, same per-call model as
  `generate_image`/`edit_image`.

## Non-goals

- Veo — not used. If a future need requires Veo specifically (e.g. Omni
  Flash proves insufficient for a use case), that is a new spec, not a
  silent addition here.
- Audio-only output — Producer (song generation,
  [spec](2026-09-03-producer-agent-song-generation-design.md)) owns that
  modality; Omni Flash's audio is embedded in generated video, not exposed
  standalone here.
- A full video player/scrubber UI — v1 ships through the existing
  attachment strip mechanism (same caveat as Director's image spec §8 and
  Producer's spec §7); a richer player is a follow-up.

## Design

### 1. Persona + agent registration

No new persona/roster entry — Director already exists in all four rosters
(`personas.ts` seed, `onboarding.ts`, `backfill-agents.ts`,
`registry.ts`). Update Director's persona `basePersonality`/description and
the `directorAgent.ts` instructions text to mention video, mirroring how
`generate_image`/`edit_image` are already described. No new seeding work.

### 2. Mastra agent

`apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` gains a third
tool: `tools: { generate_image: generateImage, edit_image: editImage,
generate_video: generateVideo }`. Instructions block gets a video section
mirroring the existing image rules:

- Call `generate_video` for a new clip from a text description, or to
  extend/edit an existing video referenced by `fileId`.
- Same `fileId`-before-claiming-success rule as images.
- Same refusal-reason vocabulary (`GENERATION_FAILED`, `STORAGE_FAILED`,
  safety refusal, `insufficientCredits`), plus a video-specific reason for
  an unsupported source (`SOURCE_VIDEO_UNAVAILABLE`/`SOURCE_VIDEO_TOO_LONG`
  — Omni Flash's editing input cap is 10s, per the model card).
- Set explicit expectations: clips are short (Omni Flash's default/typical
  output is on the order of seconds, not minutes) — confirm exact duration
  bounds during implementation, don't let the agent imply movie-length
  output.

### 3. Tool

New file `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`, same
shape as `generateImage.ts`/`generateSong.ts` (pull
`conversationId`/`idToken`/`tenantId`/`agentId` off
`execContext.requestContext`, call gateway, charge, upload, return
metadata-only output). Input schema:

```ts
inputSchema: z.object({
  prompt: z.string(),
  sourceFileId: z.string().optional(),   // present for edit/extend/interpolate
  task: z.enum(['text_to_video', 'edit', 'extend']).default('text_to_video'),
})
```

`sourceFileId` resolved through `downloadMediaAttachment`
(`apps/agent-orchestrator/src/media.ts`) — same tenancy-scoped access
pattern `editImage.ts` uses, same SSRF-avoidance reasoning (fileId, never a
raw URL).

Charge-after-success, `jobType: 'video_generation'`, new sibling
`videoCredits.ts` (`refundVideoCharge`) alongside `imageCredits.ts` and
`musicCredits.ts` — same "two homes deliberately" convention as Producer's
credit helper, not a shared abstraction.

**Timeout is the open question this spec can't resolve without
implementation-time testing.** Omni Flash supports both synchronous
(`delivery: "base64"`) and effectively-async (`delivery: "uri"` + poll
until `ACTIVE`) response modes. Default to synchronous
(`AbortSignal.timeout(90_000)`, matching Director's existing tools) for v1;
if real-world 4K/upscaled generations prove too slow for a chat turn to
hold open, switch to the `uri`+poll mode with the same SSE-heartbeat
reasoning Director's original spec §7 used to justify staying synchronous
(browser talks directly to the orchestrator host, not through API
Gateway's 29s limit) — but that's a fallback to verify, not the default
design.

### 4. Inference gateway

New file `apps/inference-gateway/src/video.ts`. **This is not a copy of
`images.ts`'s adapter shape** — Omni Flash's wire format is the Interactions
API (`interactions.create`), a third distinct shape alongside
`:generateContent` (images) and `:predict` (Lyria). The adapter builds:

```
POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/interactions
```

(exact Vertex-side path for the Interactions API needs confirmation during
implementation — the Gemini-API-key surface uses `client.interactions.create()`
via the SDK; the raw REST path on Vertex specifically was not found in
public docs during this spec's research and must be verified against
Google's Vertex-side Interactions API reference, or by testing against the
allowlisted project, before writing the adapter)

Request body: `{ model: 'gemini-omni-1.1-flash', input: prompt, response_format:
{ type: 'video', resolution, delivery: 'base64' }, generation_config:
{ video_config: { task } }, previous_interaction_id? }`. Response:
base64 video bytes embedded in a `steps`/content-block array (per delivery
mode), classified into `{ videoBase64, mimeType }` or `{ refused: true,
reason }`, same pattern `images.ts`'s `classifyGeminiImageResponse` uses.

`MODEL_ALLOWLIST` = `{'gemini-omni-1.1-flash'}` only — never
`gemini-omni-flash-preview` (deprecating 2026-09-30, allowlist-gated).

**No cross-vendor substitution, no Ollama fallback** — same reasoning as
images/music. **Gemini-API-key fallback tier**: unlike Lyria, Omni Flash
*is* confirmed available on the direct Gemini API (same model id), so a
Vertex→API-key fallback pair is possible here, matching `images.ts`'s
shape rather than `music.ts`'s single-path shape — build it if time
permits, but it's not required for v1 to function.

New route `POST /v1/video/generations` in
`apps/inference-gateway/src/index.ts`, same registration pattern as
`/v1/images/generations`.

### 5. Storage

No new work — `uploadGeneratedFile` already handles arbitrary binary
content/contentType/extension (generalized for Director's image work).
Call with `contentType: 'video/mp4'` (or whatever Omni Flash returns) and
matching extension. Quota interaction is the same known concern Director's
image spec §5 already raised — video files will be materially larger than
images, so this consumes tenant storage quota faster still; worth flagging
to whoever owns storage limits, not a new design problem to solve here.

### 6. Credits

New `credit_rates` row: `resource_type: 'video_generation'`, `subject:
'gemini-omni-1.1-flash'`, pricing schema `{ per_call_micro: <rate> }` —
rate value likely needs to vary by resolution (360p vs 4K), similar to the
media-generation doc's note that image cost scales with output size (§
"Generation cost scales with output size" in
[the media-generation doc](../../media-generation/README.md)). If so, the
credit rate subject may need to include resolution
(`gemini-omni-1.1-flash:1080p`, etc.) rather than a single flat per-call
rate — a business/pricing decision, flagged not resolved here.

### 7. Attachment delivery

Same gap Director's original spec found and fixed for images
(`chatStream.ts`'s `normalizedToolName` allowlist and `SAVE_TOOL_NAMES`) —
add `generate-video` to both sets. `AttachmentStrip.tsx`'s thumbnail
rendering needs the same audio-vs-video check Producer's spec §7 raised:
confirm it renders something sensible for `video/*` (a poster-frame
thumbnail is the natural fit, likely closer to what it already does for
images than audio needs), or ship a download affordance if not.

### 8. Deployment

Same restart/deploy surface as Director's image work and Producer:
`pm2 restart agent-orchestrator`, `pm2 restart inference-gateway`, no
Lambda changes needed (no new roster seeding required per §1).

## Tradeoffs

- **Omni Flash over Veo.** Faster, cheaper, editable, GA without an
  async-job-queue build-out. Accepted per your direction; Veo remains
  available later as a distinct spec if a use case needs its longer/
  higher-fidelity output specifically.
- **Interactions API shape is new to this codebase.** Every existing
  gateway adapter (`vertex.ts`, `gemini.ts`, `images.ts`) speaks either
  OpenAI-chat-shaped requests or Gemini's `:generateContent`/`:predict`
  shapes. This is the first adapter built against the Interactions API —
  budget implementation time for that unfamiliarity, and verify the raw
  Vertex REST path (not just the SDK) before writing the adapter, per §4.
- **Synchronous default, with a documented escape hatch.** Same reasoning
  as Director's original video-adjacent latency analysis; unlike Veo (which
  forced async by being long-running-only), Omni Flash's `delivery` param
  makes this a real choice, not a constraint — start synchronous, only
  switch if real latency demands it.

## Testing

- Unit: `generateVideo` tool `execute()` against a mocked gateway response
  — success (upload + charge), refusal, transient failure (refund), quota
  failure (refund), source-video-unavailable/too-long for the edit path.
- Unit: gateway's new `/v1/video/generations` route — request shape,
  refusal classification, allowlist rejects `gemini-omni-flash-preview`
  explicitly (regression guard against the deprecating id creeping back
  in).
- Integration: Director end-to-end through `chatStream.ts` with a recorded
  Omni Flash response — verifies `video_generation` credit charge and that
  the attachment survives the tool-name gate.
- Manual: chat with Director, request a video clip, then request an edit/
  extension referencing the first by `fileId`; confirm both round-trip
  through S3 and debit correctly. Confirm a request against
  `gemini-omni-flash-preview` (if reachable at all) is rejected by the
  allowlist, not silently served.
