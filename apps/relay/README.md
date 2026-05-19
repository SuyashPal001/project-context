# agent-relay

WebSocket + SSE relay bridging the frontend to the Mastra `platformAgent` (Saarthi).
Runs on GCP VM port 3001. Publicly exposed via NGINX at `wss://agent-saas.fitnearn.com`.

## Architecture

- **SSE path** (`/sse`) — browser EventSource for chat UI
- **WebSocket path** (`/ws`) — mobile / OpenClaw clients
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
cd /home/suyashresearchwork/serverless-saas/apps/relay
npm run build && pm2 restart agent-relay
```

> **Note:** Repo is at `/home/suyashresearchwork/serverless-saas/` (canonical).
> `/opt/serverless-saas/` is a dead clone — do not edit it.

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
