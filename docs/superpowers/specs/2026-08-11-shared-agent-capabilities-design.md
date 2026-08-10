# Shared Agent Capabilities: internal Mastra + external MCP — Design

## Problem

The previous branch (`docs/superpowers/plans/2026-08-10-mcp-context-carrying.md`) shipped `start_task`/`get_task_thread` behind a plain-JSON HTTP endpoint with `ak_`-key auth — not real MCP protocol, so no MCP client (Claude Code, Cursor, etc.) can actually connect to it without a hand-written shim, which defeats the point of building on MCP in the first place.

Fixing the transport in isolation would have been a mistake: the same capabilities also need to work for a user who never connects an external coding agent at all and instead talks to the platform's own internal agent inside the web app (`apps/agent-orchestrator`'s `platformAgent`). If the only front door is external MCP, the product's core agentic experience depends on a user granting external tool access — many won't. So capability logic must be built once and exposed through two front doors, not duplicated.

A third finding shaped this design: whichever tools get exposed externally, they currently have almost no access control beyond a single coarse permission string (`agent_tasks:read`) on the `ak_` key. Any agent holding that permission can call every tool gated by it, on every task in the tenant, with no per-agent or per-task narrowing and no approval step for anything risky. That gap needed a real answer, not just a transport fix.

## Goal

One shared, transport-agnostic tool registry as the single source of truth for capability logic. Two thin adapters in front of it:

1. **Internal** — `agent-orchestrator`'s Mastra tool-calling loop calls the registry in-process, using the already-authenticated human's own session (tenant + role permissions). No protocol, no network hop.
2. **External** — a real MCP endpoint on `apps/api` (JSON-RPC via `@modelcontextprotocol/sdk`), using `ak_`-key-derived auth, narrowed by an explicit per-agent tool assignment (not just a role permission string).

Gmail tools (owned by the existing `mcp-server/`) get proxied into the same external MCP surface without moving or duplicating their implementation.

## Non-goals (Phase 2, named but not designed here)

- **Task-scoped credentials.** Multica's model — mint a short-lived token bound to `(agentId, taskId)` at claim time, narrowing "can read every task in the tenant" down to "can read this one task" — is a real improvement over role-permission-only scoping, but it's a separate token-issuance/expiry design with its own surface area. Not building it now; `agent_tools`/`agent_tool_assignments` gating is this phase's answer to the access-control gap.
- **`stakes`/`requires_approval` enforcement UI/flow.** The `agent_tools.stakes` and `agent_tools.requires_approval` columns already exist in schema. This phase wires tools into the `agent_tools` registry (so the columns are populated and queryable) but does not build an approval workflow that blocks execution pending human sign-off — that's a follow-on.
- **Any change to `mcp-server/`'s own auth or network exposure.** It stays exactly as documented today: internal-service-key trust, `127.0.0.1`-bound, not internet-facing. `apps/api` proxies to it; it does not change.
- **Any new capability beyond `start_task`/`get_task_thread`.** This phase re-plumbs the transport and access control for the two tools that already exist; it does not add new capabilities.

## Architecture

```
                    ┌─────────────────────────────┐
                    │  shared capability package   │
                    │  (registry + handlers,       │
                    │   transport-agnostic)        │
                    └───────────┬───────────┬──────┘
                                │           │
              in-process call   │           │  registry.execute()
                                │           │  behind real MCP transport
                    ┌───────────▼──┐     ┌──▼────────────────┐
                    │ agent-        │     │ apps/api           │
                    │ orchestrator  │     │ (Lambda)           │
                    │ Mastra tool   │     │ POST /mcp          │
                    │ wrapper       │     │ (JSON-RPC)         │
                    └───────┬───────┘     └──────┬─────────────┘
                            │                     │
                  human's own session       ak_ key + agent_tools
                  (Cognito JWT, already      assignment (new gate)
                  resolved tenant/role)             │
                                              ┌──────▼─────────────┐
                                              │ proxy for tool      │
                                              │ names not owned     │
                                              │ locally (Gmail)     │
                                              └──────┬─────────────┘
                                                      │ internal-service-key
                                              ┌───────▼───────┐
                                              │  mcp-server    │
                                              │  (unchanged)   │
                                              └────────────────┘
```

## Components

### 1. Shared capability package (new)

`products/agent-platform/packages/capabilities/` — new pnpm workspace package, `@serverless-saas/agent-capabilities`. Moves the logic currently in `products/agent-platform/packages/api/mcp/tools.ts` (the `handleStartTask`/`handleGetTaskThread` functions and `registerAgentPlatformMcpTools`) here, with zero Hono/Express dependency — just Drizzle, the registry types from `@serverless-saas/mcp`, and `@serverless-saas/agent-schema`. Both `apps/api` and `apps/agent-orchestrator` depend on it directly (`workspace:*`). Package shape follows `packages/foundation/mcp` (flat `main`/`types`, `src/` rootDir, no subpath `exports` map needed — it consumes `@serverless-saas/agent-schema`'s subpath exports, it doesn't provide its own), not `agent-schema`'s wildcard-`exports` shape.

Registration adds the `agent_tools`/`agent_tool_assignments` gate: before `registry.execute()` calls a handler, it must also confirm (via a new lookup this package owns) that the calling agent has an active `agent_tool_assignments` row for this tool. This applies to both adapters — the internal path's "agent" is the platform's own system agent, not exempted from the check just because it's internal, and the human-session case is checked purely on the user's own role permission on the tool, as passed through today (this design does not change how the internal path's human-scoped access is checked, only formalizes the agent-facing gate for the external path where a specific automated agent identity, not a human, is the caller).

**Correction from implementation-plan research:** `agent_tools` is not currently unused — it's actively seeded (`packages/foundation/database/seeds/tools.ts`'s `PLATFORM_TOOLS`, ~20 platform-wide rows) and read by **two independent, already-duplicated code paths**: `packages/foundation/ai/src/tools/registry.ts` (`getAgentTools`, Drizzle) and `apps/agent-orchestrator/src/usage.ts` (`fetchToolGovernance`, raw `pg`, explicitly commented as mirroring the first). Only `agent_tool_assignments` — the actual per-agent grant table — has zero writers anywhere today; this phase is its first writer. Fixed now rather than left as adjacent debt: this phase also **deduplicates the two read paths**, extracting one shared Drizzle-based `getAgentTools`-equivalent that both `@serverless-saas/ai` and `apps/agent-orchestrator` call, since `agent-orchestrator` already depends on `@serverless-saas/database` and this work is touching exactly these tables anyway.

### 2. Internal adapter (new)

`apps/agent-orchestrator/src/mastra/tools/platform-capabilities.ts` — for each tool the shared registry exposes, defines a Mastra-compatible tool (`{id, description, inputSchema, execute}`, matching the exact shape of the existing `fetchAgentContext.ts` tool: `id` kebab-case, `inputSchema`/`outputSchema` as Zod, `execute: async (inputData, execContext) => ...`) whose `execute()`:
1. Reads the calling human's `tenantId` from `execContext.requestContext.get('tenantId')` (already set by `chatStream.ts` today) and resolves their current role permissions via a **new exported function**, `resolveUserPermissions(db, tenantId, userId)`, added to `@serverless-saas/permissions`.
2. Calls `registry.execute({name, arguments}, authContext)` in-process.
3. Maps an `isError` response into a clear string the agent's own reasoning can act on (e.g., surfacing "you don't have access to that task" back to the user), rather than letting the chat turn fail opaquely.

**Correction from implementation-plan research:** the design originally assumed permission resolution could be "reused via `@serverless-saas/permissions` — not reimplemented." No such function exists — `packages/foundation/permissions` only exports pure functions over an *already-resolved* permission set (`hasPermission`, `intersectPermissions`, etc.); the actual DB query (tenant+user → role → `role_permissions` join `permissions`) is private, inline logic in `apps/api/src/middleware/permissions.ts:38-62`, and `agent-orchestrator`'s `RequestContext` never carries `permissions` today (only `tenantId`/`agentId`/`userId`). Fixed now, not deferred: this phase extracts that query into `resolveUserPermissions(db, tenantId, userId)` in `@serverless-saas/permissions` (Drizzle-based — `agent-orchestrator` already depends on `@serverless-saas/database`, so it can call a Drizzle-based function directly for this new code path even though its own *existing* code elsewhere uses raw `pg`; no migration of `agent-orchestrator`'s existing queries required), and `apps/api/src/middleware/permissions.ts` is updated to call the same extracted function instead of keeping its own copy.

Registered into `platformAgent`'s existing tool set (`apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`'s `tools: async ({ requestContext }) => {...}` factory, spread alongside the existing `SERVER_TOOLS` map — matching how tenant-scoped tools are already registered there, not as a separate static export).

### 3. External adapter (rewrite of the earlier plain-JSON route)

`apps/api/src/routes/mcp.ts` (moved from `products/agent-platform/packages/api/routes/mcp.ts` — this is now a foundation-level concern, not agent-platform-specific, since it may host other products' tools later) — a stateless MCP server built fresh per Lambda invocation:
- `@modelcontextprotocol/sdk`'s `McpServer` + **`WebStandardStreamableHTTPServerTransport`** (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`) — **not** the Express-oriented `StreamableHTTPServerTransport` that `mcp-server/src/server.ts` uses. `mcp-server` runs on a persistent VM with real Node `http.IncomingMessage`/`ServerResponse` objects (via Express); `apps/api` runs on Lambda via `hono/aws-lambda`, which only ever has Web-standard `Request`/`Response` — no raw Node socket. The SDK ships a first-party Hono-compatible transport for exactly this case (confirmed present in the installed SDK, with an official Hono example: `transport.handleRequest(c.req.raw)` returns a `Response` directly, usable as a Hono handler's return value with no adapter shim needed). Route body:
  ```ts
  mcpRoutes.all('/', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = buildMcpServer(/* registry + auth context for this request */);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  ```
  Fresh `McpServer` per request (stateless — no persistent session state), matching the design's original intent, now on the correct transport class.
- Mounted via the existing `mountApiRoutes` path, so it inherits the full middleware chain (`apiKeyAuthMiddleware` etc.) unchanged. `apps/api/src/types.ts`'s `AppEnv` needs `apiKeyContext` added as a typed `Variables` entry (currently every consumer in `apps/api` casts through `as never`/`any` to read it — `products/agent-platform/packages/api`'s copy of `AppEnv` already types it properly; align `apps/api`'s own type to match rather than adding another untyped cast).
- On `tools/list`: merges the shared registry's local tool definitions with a short-cached (60s) fetch of `mcp-server`'s live tool list (internal-service-key channel). No existing internal-HTTP-client helper exists anywhere in the repo (confirmed by repo-wide search) — this phase writes one small fetch wrapper for the `x-internal-service-key`/`x-tenant-id`/`x-agent-id` header pattern, since it's now needed in two new places (list-merge and call-proxy) and didn't exist before.
- On `tools/call`: dispatches to the local registry if the tool name is registered there; otherwise proxies to `mcp-server` using the caller's already-resolved `tenantId`/`agentId` as `x-tenant-id`/`x-agent-id` headers — the same trust model `mcp-server` already expects from internal callers, unchanged on its side.

`apps/api/package.json` needs `@modelcontextprotocol/sdk` added at the version already pinned in `mcp-server/package.json` (`^1.10.2`), to keep both services on the same SDK version.

### 4. `agent_tools` / `agent_tool_assignments` wiring (new)

A migration adds `start_task`/`get_task_thread` to the existing `PLATFORM_TOOLS` seed list (`packages/foundation/database/seeds/tools.ts`) — both `stakes: 'low'`, `requires_approval: false` (they're read-only) — following the established seeding path rather than inventing a new one. `agent_tool_assignments` is not auto-populated for existing agents; a backfill migration grants assignment to every currently-active `ops-agent`/`custom-agent` (matching how permission grants were backfilled in the previous branch — `packages/foundation/database/migrations/0050_grant_agent_tasks_read.sql` is the direct precedent), so existing agents aren't silently locked out the moment this ships. This is decided here, not left open: auto-grant on backfill, explicit tenant action required only for *new* agents going forward.

## Data flow

**External:** Claude Code (or any MCP client) → `POST /mcp` on `apps/api` → `apiKeyAuthMiddleware` resolves tenant + role permissions from the `ak_` key (existing, unchanged) → new gate: does `agent_tool_assignments` have a row for (this agent, this tool)? → `registry.execute()` → shared capability handler → DB (tenant-scoped, unchanged) → JSON-RPC response.

**Internal:** user sends a chat message → `agent-orchestrator` already knows their tenant/role from the Cognito session → `platformAgent`'s tool-calling loop selects the wrapped tool → wrapper resolves the human's auth context → `registry.execute()` in-process → shared capability handler → DB → result folded into the agent's synthesized reply.

## Error handling

The registry already converts unknown-tool, permission-denied, and handler-throw cases into structured `isError` responses (`packages/foundation/mcp/src/registry.ts`, unchanged) — both adapters reuse this as-is. New failure mode this design introduces: the `agent_tool_assignments` gate failing should produce the same `isError` shape as a permission failure (not a different error type), so callers don't need to distinguish "no permission" from "no assignment" — both mean "you can't use this tool right now." The Gmail proxy path treats an `mcp-server` timeout/failure as an `isError` response, not a raw 500, so an external agent gets a structured failure it can reason about instead of a transport-level crash.

## Testing

- Shared capability package: existing unit tests for `handleStartTask`/`handleGetTaskThread` move with the code, unchanged in substance; add coverage for the new `agent_tool_assignments` gate (agent with the right permission but no assignment row is denied).
- `resolveUserPermissions` (new, `@serverless-saas/permissions`): unit test directly against the extracted query logic; `apps/api/src/middleware/permissions.ts`'s existing tests continue to pass unchanged since it now calls the extracted function rather than inlining the query.
- Deduplicated `getAgentTools`: `packages/foundation/ai/src/tools/registry.ts`'s existing tests continue to cover the merged logic; `apps/agent-orchestrator/src/usage.ts`'s raw-`pg` version is deleted, not tested separately.
- Internal adapter: unit test the auth-context resolution in isolation (mocked session → correct tenant/permissions reach `registry.execute()`), and that an `isError` response is surfaced as agent-readable text, not a crash.
- External adapter: extend the existing route-test pattern (`mcp.route.test.ts`) to the new JSON-RPC surface — `tools/list` merge behavior (local + proxied), `tools/call` dispatch (local vs. proxied), and the auth-rejection paths.

## Resolved decisions (previously open questions)

- **`agent_tool_assignments` backfill:** auto-grant to every currently-active `ops-agent`/`custom-agent` via migration (same pattern as `0050_grant_agent_tasks_read.sql`); explicit tenant action required only for new agents going forward.
- **Internal vs. external tool set:** identical for this phase — both `start_task` and `get_task_thread` are exposed through both adapters, since the design's whole premise is one registry serving both front doors. A tool being internal-only or external-only is a per-tool decision for whenever a tool actually needs that asymmetry; nothing in this phase does.
