# Director agent — image generation & editing

Date: 2026-09-01

## Summary

New official, user-facing agent, "Director," that generates and edits images
via Gemini 3 Pro Image (`gemini-3-pro-image-preview`), synchronously, inline
in chat. Video generation (Gemini Omni Flash) is explicitly deferred — not in
this spec.

## Goals

- Add a Director persona/agent to the built-in roster (same tier as Disco,
  PM Agent, Architect).
- User asks Director for an image (text-to-image) or to edit an existing
  image (edit-in-place), and gets a result inline in the chat turn.
- No new job/queue infrastructure, no new credit machinery, no new S3 code
  path — reuse what chat turns and generated-file uploads already have.

## Non-goals

- Video generation (Gemini Omni Flash) — future spec.
- Async/job-queued generation — deferred; revisit if Gemini 3 Pro Image
  latency or cost profile changes this call.
- Per-generation credit metering — deferred; flat per-chat-turn charge
  applies uniformly for now (see Tradeoffs).

## Design

### 1. Persona + agent registration

- Add a `director` entry to `DEFAULT_PERSONAS` in
  `products/agent-platform/packages/api/seeds/personas.ts`, following the
  `disco`/`pm`/`architect` shape (slug, name, tagline, basePersonality,
  skillTags). `isOfficial: true`, seeded as `draft` like the others —
  publishing (attaching an avatar) happens separately via the existing ops
  flow, generated through `PersonaAvatar`, never `exampleAssetUrl`.
- Add `'director' → directorAgent` to `AGENT_REGISTRY` in
  `apps/agent-orchestrator/src/mastra/registry.ts`, and add "Director" to
  `DEFAULT_AGENTS` so per-tenant onboarding/backfill seeds it alongside
  Disco/PM Agent/Architect.

### 2. Mastra agent

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

### 3. Tools

Two new tool files under `apps/agent-orchestrator/src/mastra/tools/`:

- `generateImage.ts` — text-to-image. `createTool()` pattern matching
  `fetchAgentContext.ts` (id, description, requestContextSchema,
  zod inputSchema/outputSchema, execute).
- `editImage.ts` — edit an existing image. Same pattern, input schema also
  takes a source image reference (URL/attachment id already in the
  conversation).

Both `execute()` implementations call the inference gateway with model
`gemini-3-pro-image-preview`.

### 4. Inference gateway

Extend `apps/inference-gateway/src/adapters/vertex.ts` (Vertex/ADC path,
primary) to accept `generationConfig.imageConfig` and return image bytes for
`gemini-3-pro-image-preview`. The `gemini.ts` adapter (API-key fallback,
already wired via `GEMINI_API_KEY`, used only if Vertex fails) gets the same
model support so the fallback path isn't silently narrower than primary.
`VERTEX_MODEL` env var stays as-is for the chat model; image model is
selected explicitly by the tool, not read from that env var.

### 5. Storage

Tool `execute()` uploads the returned image bytes through the same 3-hop
flow already used for generated content (`persistence.ts`,
`uploadGeneratedFile`-style: `POST /api/v1/files/upload` → `PUT` presigned
URL → `POST /api/v1/files/:id/confirm`), proxying through the main API's
`/files` routes. No direct S3 SDK calls added to agent-orchestrator. Returns
an attachment payload the chat stream renders inline, same as any other chat
attachment.

### 6. Credits

No new charge code. `debitChatTurn` (`apps/agent-orchestrator/src/credits.ts`,
called from `chatStream.ts` on the `finish` event) already fires per chat
turn regardless of tool calls, at a flat rate keyed by chat model — this
covers Director's turns without new code.

## Tradeoffs

- **Flat per-turn credit charge, not per-generation.** An image-gen or
  image-edit turn costs the same as a plain text turn, even though the
  underlying Gemini image call costs more per-call than a text completion.
  Accepted for v1 to avoid new credit-metering code; revisit if usage shows
  this materially undercharges.
- **Synchronous, not job-queued.** Matches Gemini 3 Pro Image's few-second
  to ~30s latency. If real-world latency or timeouts prove this wrong,
  upgrade to the `agent_tasks`/worker job pattern used elsewhere in the
  agent platform.

## Testing

- Unit: `generateImage`/`editImage` tool `execute()` against a mocked
  inference-gateway response — verifies upload flow and attachment payload
  shape.
- Integration: Director agent end-to-end through `chatStream.ts` with a real
  (or recorded) Gemini image response — verifies credit debit fires once per
  turn and the image attachment renders.
- Manual: chat with Director in dev, request an image, then request an edit
  to it; confirm both round-trip through S3 and appear in chat.
