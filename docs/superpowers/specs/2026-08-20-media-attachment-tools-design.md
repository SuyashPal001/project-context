# Audio/video attachment understanding — on-demand tools

**Date:** 2026-08-20
**Status:** Approved for planning

## Context

`POST /api/chat` (SSE) used to route every audio/video attachment through a
synchronous download-then-process pipeline in `buildMastraMessage()`
(`apps/agent-orchestrator/src/routes/chatStream.ts`) before the stream sent
any bytes: `transcribeAudio()` (Google Speech-to-Text) for audio,
`extractVideoFrames()` (ffmpeg via `execFileSync`) for video, both in
`apps/agent-orchestrator/src/media.ts`.

`projectcontext.co` is fronted by Cloudflare, which terminates real HTTP/3
(QUIC) with the browser (confirmed: `server: cloudflare`,
`alt-svc: h3=":443"`). A `200` response that then sits silent for the length
of a slow transcription call gets its QUIC stream killed by Cloudflare's
edge, surfacing in Chrome as `ERR_QUIC_PROTOCOL_ERROR` and looping through
the client's warmup-retry logic (`apps/web/hooks/useChat.ts`) — this was
reported as "uploading any audio file breaks chat."

As an immediate stopgap (shipped, commits `1fe5135` and `aa40577`), audio and
video were excluded from the synchronous `mediaAttachments` filter entirely.
Attachments still reach chat history via `saveUserMessage()` (finish and
error paths, `chatStream.ts`), but the agent has no way to understand their
content — the capability was removed, not fixed.

This spec is the real fix: give the agent **on-demand tools** to pull and
understand audio/video, so processing happens as a normal in-turn tool call
(already streaming-safe) instead of gating the connection open.

## Scope

- New Mastra tools: `analyzeAudio`, `analyzeVideo`.
- Attachment-discovery note injected into the agent's message so it knows a
  file is attached and can choose to call a tool.
- Provider change: audio moves from a dedicated Google Speech-to-Text client
  to Gemini's native audio input via the existing inference-gateway path.
- Bounded runtime budgets with graceful degradation, replacing "hang until
  something kills the connection" with "finish partial, label it partial."
- Per-session local caching of a downloaded attachment so multiple tool
  calls against the same file don't re-fetch from S3 each time.

**Out of scope (explicitly deferred, not half-built here):**
- Any job-ID + poll / background-worker pattern for generation or edits
  (producing a new video/audio artifact back to the user). Reference:
  Higgsfield's own tools only use job-ID+poll for *generation*; analysis
  stays synchronous-with-timeout-and-degrade, which is the pattern this spec
  follows. Add the poll pattern later, additively, only if degrade-gracefully
  proves insufficient in practice.
- Cross-conversation caching of analysis results keyed by `fileId`. Mastra's
  per-conversation thread memory already avoids redundant re-analysis within
  one conversation, which covers the common case.
- Chunking multi-hour files. Hard size ceilings reject those outright for
  now (see Error handling).

## Decisions made during design

- **Tool-call, not background worker, for understanding.** Mirrors how
  Higgsfield's own analysis tools behave (confirmed via direct Q&A): sync
  calls with a timeout, degrading to a cheaper pass when a clip is too long,
  never a silent queue for analysis. Reuses this codebase's existing
  tool-calling loop and `tool_call`/`tool_done` SSE events
  (`chatStream.ts`'s `toolCallNames`, already rendered client-side) — no new
  infrastructure.
- **Audio moves to Gemini-native input via the inference-gateway**, dropping
  the separate `@google-cloud/speech` client and its service-account
  keyfile (`/opt/agent-orchestrator/vertex-sa-key.json`). Same pattern
  `apps/agent-orchestrator/src/mastra/tools/geminiExtract.ts` already uses
  (`POST {INFERENCE_GATEWAY_URL}/v1/chat/completions`), which also gets
  audio onto the same cost-tracking path (`persistCost`) as every other
  model call. Google STT's synchronous `recognize()` API caps out around ~1
  minute of inline audio — stricter than our existing 35MB size check even
  allowed for — so today's code was already silently falling through to a
  "send raw audio bytes as an image content part" fallback for anything
  longer. That fallback is removed, not preserved.
- **Tool input is `fileId`, not a presigned URL.** URLs baked into agent
  context can go stale (conversations get revisited days later past
  presigned-URL expiry). The tool re-fetches a fresh URL server-side the
  same way the frontend already does client-side
  (`GET /api/v1/files/{fileId}/presigned-url`).
- **`mode: 'quick' | 'deep'`** is a tool parameter, agent-chosen based on
  what the user asked for ("what's in this clip" → quick; "give me the full
  transcript" → deep). Defaults to `quick` absent a strong signal.
- **No new persistence layer.** Tool results ride Mastra's existing
  `PostgresStore` thread memory. This is a design assumption to verify
  during implementation, not new code to write.

## Design

### 1. Attachment discovery

`buildMastraMessage()` currently returns `preamble + sessionCtx + message`
with no mention of excluded attachments — the agent has no signal a file was
attached. Add a compact note for every `audio/*` / `video/*` attachment:

```
<attachments>
- audio: "voice-memo.mp3" (fileId: abc123) — call analyzeAudio if you need to understand its content
- video: "demo.mov" (fileId: def456) — call analyzeVideo if you need to see what's in it
</attachments>
```

Appended the same way text-doc content is currently prepended in
`buildMastraMessage` (see the `textDocs` loop).

### 2. Tool shape

Both tools follow the `createTool` pattern from `geminiExtract.ts`
(`inputSchema/outputSchema` via zod, `execute` does the work, structured
failure return instead of throwing):

```ts
analyzeAudio({ fileId: string, mode: 'quick' | 'deep' })
  -> { success: true, transcript: string, partial?: boolean }
   | { success: false, error: string }

analyzeVideo({ fileId: string, mode: 'quick' | 'deep' })
  -> { success: true, summary: string, frameCount: number, partial?: boolean }
   | { success: false, error: string }
```

`execute()`:
1. Re-fetch presigned URL for `fileId` via `/api/v1/files/{fileId}/presigned-url`.
2. Check per-session local cache (temp dir keyed by `fileId`) before
   downloading — reused across multiple tool calls against the same
   attachment within one turn/session, same shape as the existing
   `MEDIA_DIR` temp-file handling in `media.ts`.
3. Reject outright (structured error, no attempt) if the file exceeds the
   hard size ceiling — keep the existing caps: 35MB audio, 200MB video
   (`media.ts:100`).
4. **Audio:** call inference-gateway with the audio content part (Gemini
   native), same request/retry/cost-tracking shape as `geminiExtract`'s
   `callGateway`.
5. **Video:** `execFile` (not `execFileSync` — see below) `ffprobe`/`ffmpeg`
   to sample frames (quick: existing `MAX_FRAMES = 8`; deep: a larger
   sample within the time budget), then one gateway call over the frames.
6. On exceeding the mode's time budget mid-call: return what's completed so
   far with `partial: true`, never hang past the budget and never throw.

### 3. `execFileSync` → `execFile`

`extractVideoFrames()` currently blocks Node's entire event loop for the
duration of the ffmpeg call — not just the current request, every concurrent
request on the orchestrator. Switching to the async `execFile` (promisified)
fixes this independent of everything else in this spec — one tenant's video
job shouldn't stall another tenant's chat turn.

## Error handling

| Condition | Behavior |
|---|---|
| File exceeds hard size ceiling (35MB audio / 200MB video) | Reject before attempting; structured error, agent relays "file too large (Xmb, cap is Ymb)" |
| `quick` mode budget (~30–60s) exceeded | Return partial result, `partial: true` |
| `deep` mode budget (~120–180s) exceeded | Truncate (first N minutes audio / capped frame count video), return partial with a note it's truncated |
| Presigned-URL fetch fails, or download fails | Structured `{ success: false, error }`, never throws past the tool boundary |
| Gateway call fails (matches `geminiExtract`'s existing retry-on-503 pattern) | Retry per existing `callGateway` shape, then structured failure |

Budget numbers are starting points, not measured — first implementation
pass should log actual durations against real files to calibrate before
these are treated as final.

## Testing

Existing precedent in this repo:
`apps/agent-orchestrator/src/mastra/__tests__/serverTools.test.ts` exists
specifically because `retrieve_documents` was written, unit-tested, and
never registered on the agent — the system prompt instructed agents to call
it, but the tool wasn't in the registered toolset, so it silently never
fired. Same risk applies to `analyzeAudio`/`analyzeVideo`.

- Unit tests for each tool's `execute()` — mocked gateway responses (success,
  timeout/partial, oversized input, malformed/undownloadable file).
- A pinning test asserting `analyzeAudio` and `analyzeVideo` actually appear
  in the agent's registered toolset (same shape as `serverTools.test.ts`).
- Test that `buildMastraMessage` appends the attachment-discovery note for
  audio/video and excludes them from the synchronous `mediaAttachments`
  processing path.
- Manual verification: upload a real audio/video file through the chat UI,
  confirm no QUIC error / no blocked connection, confirm the agent can
  choose to call the tool and produce a sensible result.

## Open questions for implementation

- Confirm real Gemini audio duration/size limits via the inference-gateway
  (this spec assumes "meaningfully more generous than Google STT's ~1
  minute sync cap" but the exact number needs a real check).
- Confirm the right auth header for the orchestrator calling
  `/api/v1/files/{fileId}/presigned-url` server-to-server (likely the
  existing internal-service-key pattern `mcp-server`/`inference-gateway`
  use, per CLAUDE.md).
- Verify Mastra's `PostgresStore` thread memory does in fact persist tool
  call results, not just the assistant's final text — this spec's "no new
  persistence layer" decision depends on it.
