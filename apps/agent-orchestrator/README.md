# agent-orchestrator

WebSocket + SSE relay bridging the frontend to the Mastra `platformAgent` (Saarthi).
Runs on GCP VM port 3001. Publicly exposed via NGINX at `wss://agent-orchestrator.projectcontext.co`.

## Architecture

- **SSE path** (`/sse`) — browser EventSource for chat UI
- **WebSocket path** (`/ws`) — mobile clients
- **Model** — `gemini-2.5-flash` via `@ai-sdk/google` → vertex-proxy (`:4001`) → Vertex AI
- **Memory** — Mastra Memory with PostgresStore (`mastra` schema, Neon DB)
- **Tools** — SERVER_TOOLS (`internet_search`, `web_fetch`, `create_plan_from_prd`) + per-tenant MCP tools (`:3002/sse`)

## Key modules

| File | Purpose |
|---|---|
| `src/mastra/model.ts` | `saarthiModel` + `saarthiLiteModel` — isolated to avoid circular TDZ dep |
| `src/mastra/agents/platformAgent.ts` | One agent serving all tenants; dynamic prompt, tools, and model |
| `src/mastra/memory.ts` | Singleton Memory instance; isolation via `resourceId` |
| `src/mastra/tools.ts` | Persistent MCPClient singleton per tenant |
| `src/mastra/thinking.ts` | Dynamic thinking budget: 0 / 1024 / 8192 based on message complexity |
| `src/mastra/index.ts` | Mastra instance + re-exports |
| `src/routes/chat.ts` | Auth, rate limit, quota, parallel pre-stream fetches, SSE setup |
| `src/routes/chatStream.ts` | Async stream handler: message build, agent stream loop, metrics |

## Performance notes

- MCP client is a **persistent singleton per tenant** — no reconnect per message
- MCP tools cached 5 min in-process; platform prompt cached 5 min
- `auth/me` + quota + working memory fetched in parallel (`Promise.all`) before stream starts
- `done` SSE event fires on Mastra `finish` event — memory:save (~2.5s) runs in background
- **Model tiering**: `thinkingBudget=0` → `gemini-2.5-flash-lite`; else `gemini-2.5-flash`. Dynamic via `requestContext` in `platformAgent.ts`
- **Memory recall skipped** for `budget=0` turns (`lastMessages: false`) — saves ~0.57s on conversational messages
- Mastra Studio at `http://localhost:3010` for span-level latency traces

## Deploy (GCP VM)

```bash
cd /home/suyashresearchwork/project-context/apps/agent-orchestrator
npm run build && pm2 restart agent-orchestrator

## Environment variables (relay .env)

| Variable | Purpose |
|---|---|
| `VERTEX_PROXY_URL` | vertex-proxy base URL (default `http://localhost:4001`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP service account key path for ADC |
| `MCP_SERVER_HTTP_URL` | MCP server SSE URL (default `http://localhost:3002/sse`) |
| `DATABASE_URL` | Neon DB connection string (Mastra memory + plan writes) |
| `MASTRA_MODEL` | Gemini model name (default `gemini-2.5-flash`) |
| `MASTRA_LITE_MODEL` | Lite model for budget=0 turns (default `gemini-2.5-flash-lite`) |
| `EXA_API_KEY` | Exa search API key for `internet_search` tool |

## Internal test MCP

`src/testMcp/` runs a second MCP server, inside the same orchestrator process, so
Claude Code can drive the live product — real tools, real credits, real Gemini calls —
on one capped test tenant. It is wired into `src/index.ts` and starts automatically
whenever its env is present; it never blocks orchestrator startup and never crashes it
(`startTestMcp` catches everything and logs one `[test-mcp] disabled: <reason>` line).
It is internal only: localhost-bound, one shared service key, no public exposure.

### Env vars (`TEST_MCP_*`, see `.env.example`)

Off unless `TEST_MCP_ENABLED=1`. Once on, config loading is all-or-nothing — if any
required var is missing it throws at startup (logged as a disabled-line, not a crash):

| Var | Required | Purpose |
|---|---|---|
| `TEST_MCP_ENABLED` | — | Must be `1` to turn the server on at all |
| `TEST_MCP_PORT` | no (default `3007`) | Port the test MCP HTTP listener binds on `127.0.0.1` |
| `TEST_MCP_TENANT_ID` | yes | The capped test tenant. Start-up refuses an unlimited-plan tenant. |
| `TEST_MCP_AGENT_ID` | yes | Olmo agent id on that tenant, used for route-1 context and route-2 chat |
| `TEST_MCP_EMAIL` | yes | Test user's Cognito username |
| `TEST_MCP_PASSWORD` | yes | Test user's permanent Cognito password |
| `TEST_MCP_COGNITO_CLIENT_ID` | yes | Cognito app client id (must allow `USER_PASSWORD_AUTH`) |
| `API_BASE_URL` | yes | Already an existing orchestrator var — reused as-is, not `TEST_MCP_`-prefixed |
| `COGNITO_REGION` | no (default `ap-south-1`) | Reused from the orchestrator's existing var |
| `PORT` | no (default `3001`) | Reused to build the self-call base URL for route 2's `/api/chat` |

Also required regardless of the `TEST_MCP_*` block: `INTERNAL_SERVICE_KEY`, which every
request to the test MCP must present as the `x-internal-service-key` header — same key
the orchestrator, the Lambdas, and `mcp-server` already share.

Never put real values in the committed `.env.example` — only the commented-out shape.
Real values go in the local, gitignored `apps/agent-orchestrator/.env`.

### What it exposes

Two routes, both tenant/user/conversation-scoped to the test identity — tool arguments
can never choose the tenant:

- **Route 1 — direct product tools.** Every tool in `DIRECTOR_TOOLS`
  (`src/mastra/agents/directorAgent.ts`) is re-wrapped (`wrapTool.ts`) so Claude can call
  it directly: `generate_image`, `generate_video`, `analyze_video`, `capture_webpage`,
  etc. The wrapper supplies `tenantId`, `userId`, `agentId`, `conversationId`, `idToken`
  and a fresh `sessionId` via `RequestContext`, and `allowMode: 'auto'`. It deliberately
  drops `requireApproval` and every other `createTool` option from the original tool —
  on route 1 Claude is the approver, and the test tenant's capped balance is the actual
  limit, so there is no card to show and nothing to wait on. Call `test_new_conversation`
  first so a run's outputs land in one chat. The "current" route-1 conversation lives
  only in orchestrator memory — an orchestrator restart loses it, so call
  `test_new_conversation` again after a restart.
- **Route 2 — chat as the test user.** `olmo_send` / `olmo_read` / `olmo_answer` drive
  `ChatDriver` (`chatDriver.ts`), a headless copy of the web chat client: it posts to the
  orchestrator's own `/api/chat` with the test user's real id token, reads the SSE stream
  in the background, and answers cards (question/confirm/approval/upload) through the
  same routes the web UI calls. This is the same code path a real user hits.

Shared tools: `test_status` (tenant/user/agent/balance/current conversation),
`test_new_conversation`, `get_file` (short-lived download URL), and `olmo_trace`
(tool/agent spans for a conversation, read from the Mastra observability store, not
from `mastra_messages` or pm2 logs).

`olmo_trace` (always) and `olmo_send` (only when given a `conversationId`) call
`assertOwnConversation` first and refuse a conversation the test user doesn't own — a
GET on `/api/v1/conversations/:id` must return 200 before the call proceeds, since that
route is already tenant+user scoped server-side. `olmo_read` and `olmo_answer` don't
make that same check: `olmo_answer` only acts on runs this server itself started and is
still tracking in memory, and `olmo_read`'s restart fallback (when the in-memory run is
gone) reads prior messages through the tenant-scoped `/api/v1/conversations/:id/messages`
API using the test user's own id token, so it can't read another tenant's or user's
conversation either way.

### Protocol and Claude Code config

The server advertises `protocolVersion: '2026-07-28'` but is built with `@mastra/mcp`'s
stateless fallback, so an older-protocol client — Claude Code included — still connects
fine on the same `/mcp` endpoint; there's no separate legacy path to configure.

Local orchestrator:

```bash
claude mcp add --transport http --scope local platform-test http://127.0.0.1:3007/mcp \
  --header "x-internal-service-key: $INTERNAL_SERVICE_KEY"
```

`--scope local` keeps the key out of any committed config. Never paste the key into
chat.

Against the VM, tunnel first, then run the same `claude mcp add`:

```bash
ssh -N -L 3007:127.0.0.1:3007 <vm>
```

Several route-1 tools (video generation, lipsync, assembly) run for minutes. Start
Claude Code with a longer client-side tool timeout so a long call doesn't time out
before the tool itself returns:

```bash
MCP_TOOL_TIMEOUT=600000 claude
```
