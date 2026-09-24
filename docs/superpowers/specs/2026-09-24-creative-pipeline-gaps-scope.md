# Creative-ad pipeline gaps — scope

Date: 2026-09-24
Status: v1 — scope only, not yet designed or built. Each item below still
needs its own design pass before implementation, matching how
`template-video-generation`, `talking-head`, etc. each got a separate
`-design.md` + `-plan.md` before being built.

## How this list was produced

Walked the actual creative-ad generation flow step by step — avatar
creation, voice selection, product+avatar merge (cast sheet), narration,
lip-sync, template cloning, motion — checking each step against real code
on `origin/main` (`directorAgent.ts`, `platformAgent.ts`, `generateVideo.ts`,
`generationApproval.ts`, `ChatInput.tsx`) rather than assumption. Two
claims were corrected mid-session after turning out wrong: `ugc-character`
and `ugc-first-frame` were initially reported as unbuilt (a grep for the
hyphenated slug missed the code's `UGC_CHARACTER_SECTION`/prose naming —
both are actually shipped), and a gate-fatigue "approve once" mode was
initially reported as missing when it's actually built and wired
(`allowMode: 'ask'|'auto'`, see #5 below). Lesson for future scoping passes
on this repo: verify with `git grep -i` using both hyphenated and
underscore/prose variants, and check `docs/media-generation/README.md`,
before reporting something as unbuilt.

**Explicitly out of scope for this batch:** the `tvc-character` skill (no
code, no research done yet) — deferred separately.

## 1. `match_avatars` ranking

The avatar library is real and built — 6 platform-owned presets
(`products/agent-platform/packages/api/seeds/creative-library-assets.ts`),
genuine S3 storage under `creative-library/avatars/`, not tenant-scoped.
What's missing is scoring: today it's a static list you browse and click,
not a free-text-brief → ranked-by-fit picker. With only 6 presets this is
low-value today, but the mechanism should exist before the library grows
past what's eyeballable in one glance.

## 2. `match_voices` ranking

Same gap, same shape, different catalogue: 8 Cartesia voice presets
(`packages/foundation/database/scripts/refreshVoiceCatalogue.ts` — Asher,
Carson, Cathy, Connie, Corey, Lauren, Nandi, Theo), each with a
name/cover/sample, no scoring against a free-text brief ("something warm
and friendly"). Concretely blocks: asking for a voiceover on an avatar
without naming a specific preset — today the agent has no way to resolve
"pick something that fits" to a real `voiceId`.

## 3. Canvas asset grid — rescoped to batch-progress visibility

Originally scoped as a general review surface, then rescoped down once #5
(per-stage accept/iterate gates) covers the review need. What's left:
visibility during **parallel batch generation**. `generate_videos`/
`generate_images` batch calls (`batchRunner.ts`) return results together at
the end — no incremental per-item streaming today — so there's no way to
watch item 1 finish while items 2–4 are still generating. `renderCanvas.ts`
today only supports markdown document panels (`document/prd/roadmap/tasks`
types), no media type at all.

Good news for scope: the data shape already exists. Every generated asset
(image/video/narration/song) already produces an `AttachmentPayload`
(`{fileId, name, type, size, generation: {creditsUsedMicro, model}}`) via
`attachmentFromCanvasToolResult` in `chatStream.ts` — no new backend shape
needed, just a tile-grid UI reading the same attachments, plus per-item
progress state during an in-flight batch call.

## 4. Standalone voice-on-demand tool

`generate_narration` only exists wired inside the talking-head and
animation-character skill contracts (`directorAgent.ts`), always requiring
a full script and the whole ad-build intake. `producerAgent.ts` — the
agent `ROUTING_CONTRACT` sends bare "create audio" requests to — only has
`generate_song` wired, nothing for speech. So "upload a product photo, give
it a voiceover" or "give this avatar a line" has no path today: it either
misroutes to the music-only producer agent, or forces the user through a
full ad-pipeline intake for what should be a lightweight, standalone call.

## 5. Per-stage accept/iterate gates

Cost-approval is solved and uniform: `allowMode: 'ask'|'auto'`
(`apps/web/components/platform/chat/ChatInput.tsx`, persisted on
conversation metadata, read by `shouldRequireApproval()` in
`generationApproval.ts`) gates all 16 generation-adjacent tools
consistently, and `auto` mode skips every cost card for a conversation.
What's separately missing is **quality review** — actually looking at a
result and accepting or rejecting it, not just approving its cost. Today
that only exists for per-beat stills (the "board gate": approve the whole
set together, reject one and regenerate it as a fresh paid call). Missing
everywhere else in the chain:

- Cast sheet — highest priority. Every downstream beat/clip anchors its
  identity to this one `fileId`; a bad cast sheet propagates silently
  through everything built on top of it, with no checkpoint to catch it
  early. Currently only gets a pre-generation cost approval, no post-result
  review.
- Per-beat video, lip-sync result, assembly, final delivery — same gap,
  lower priority than the cast sheet but still real.

Quality gates should be a genuinely separate mechanism from `allowMode` —
`auto` mode should still skip cost-approval friction, but a quality-review
checkpoint (at minimum, the cast sheet) answers a different question
("is this actually right") that cost approval never addresses.

## 6. Proactive next-step suggestions

The agent never offers a relevant next step after a result lands — e.g.
after a cast sheet is approved, nothing suggests "want her to talk, with
lip-sync?" It only reacts to what the user explicitly asks for next. The
one existing proactive-suggestion pattern in the prompts
(`platformAgent.ts`'s animation-character Gate 0 fit check) only fires to
redirect a bad-fit request to a different skill, never to surface a
capability the user hasn't thought to ask for.

## 7. Cross-skill continuation contract

No skill checks working memory's Locked Reference Artifact IDs for an
already-approved cast sheet/avatar/voice/product before generating fresh
ones. Confirmed concretely absent in two places:

- `TALKING_HEAD_CONTRACT` (`platformAgent.ts`) step 4 always generates a
  new cast sheet — no check for one already approved earlier in the same
  conversation (contrast with `UGC_FIRST_FRAME_CONTRACT`, which does
  explicitly reuse a still approved on an earlier UGC-character board).
- `TEMPLATE_VIDEO_CONTRACT` step 2 just asks for a product photo "if one
  hasn't been provided" — no working-memory lookup either.

Without this, asking the agent to "combine the avatar, voice, and product
we already built into one video" either regenerates a redundant (and
possibly inconsistent) cast sheet, or requires the user to manually
re-supply everything that was already approved and paid for.

Same gap underlies the existing "smart enough to figure it out" concern:
tools are technically all available on the same Director agent, but a
documented live-tested failure (`platformAgent.ts` comment: Olmo, given no
explicit routing instruction, tried `retrieve_documents` then
`list_folder` then hallucinated a spec instead of calling agent-director)
shows unguided tool-chaining is unreliable in this codebase, not a
theoretical risk. This is the same class of fix as the other 6 skill
contracts already written and already working — new prose contract, not
new infrastructure.

## 8. Narration support for template-cloning

Structurally absent, not just unreused. `TEMPLATE_VIDEO_CONTRACT` never
calls `generate_narration` at all. Per `BRIEF_SELECTIONS_CONTRACT`, if a
user has already picked a voice and the request routes to template-cloning,
the agent is required to tell them plainly that the voice will be ignored
and ask them to confirm — a designed, intentional drop, not a bug, but a
real capability gap if template-cloning is meant to support spoken ads.

## 9. Motion-transfer-capable video model integration

`analyze_video` genuinely extracts real structured motion detail from a
reference clip (shot type, action, timing), and that description threads
into `generate_video`'s prompt via the recreation contract — this part is
real and working. The ceiling: it's text-redescription-then-regeneration,
not literal video-to-video motion transfer. `videoItemSchema`
(`generateVideo.ts`) only accepts still-image inputs
(`startImageFileId`/`referenceFileIds`), no reference-video/motion field at
all — the video model never sees the reference clip's actual pixels or
motion at generation time.

This isn't a missing feature so much as the ceiling of the current
approach — closing it means integrating a model with real
video-conditioning/motion-transfer support, which is exactly what the
already-settled multi-vendor generation planner in
`docs/media-generation/README.md` (Wan Animate / Seedance / Veo) exists to
support. This is the integration point, not a new architecture.
