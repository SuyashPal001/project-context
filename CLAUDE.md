# CLAUDE.md — Briefing for Claude Code

## What this repo is

A multi-tenant SaaS platform with an agentic AI layer built on top. The foundation handles auth, tenancy, billing, roles, notifications, webhooks, files, and audit. The agent platform adds async task planning, real-time agent orchestration, and MCP tool integrations.

Domain: **projectcontext.co**

---

## Stack at a glance

- **Monorepo:** pnpm workspaces — `apps/*`, `packages/foundation/*`, `products/*/packages/*`
- **API:** Hono on AWS Lambda (SAM-deployed), Lambdalith pattern
- **Web:** Next.js (App Router) + Tailwind + shadcn/ui
- **Worker:** SQS-driven Lambda for background jobs
- **Agent orchestrator:** Hono + Mastra + WebSocket on GCP VM (port 3001)
- **MCP server:** Standalone Node.js service on GCP VM (port 3002) — Gmail, Google integrations
- **AI service:** Python FastAPI (port 3004) — document processing
- **Inference gateway:** Node.js proxy (port 4001) — Vertex AI / Gemini
- **DB:** Supabase PostgreSQL (pgvector) + Drizzle ORM
- **Cache:** Upstash Redis
- **Auth:** AWS Cognito with Google OAuth + pre-token generation Lambda
- **Storage:** S3
- **Infra:** Terraform modules + AWS SAM

---

## Repo layout

```
apps/
  api/              Hono Lambda — REST API (Lambdalith)
  web/              Next.js — auth, dashboard, ops console
  worker/           SQS Lambda — background jobs
  agent-orchestrator/ Mastra agent orchestrator — SSE + WebSocket bridge to frontend
  ai-service/       Python FastAPI — document AI processing
  inference-gateway/ Node.js proxy — Vertex AI / Gemini

packages/foundation/
  ai                LLM provider clients (Vertex, Anthropic)
  auth              Cognito client, JWT verification, session blacklist
  cache             Upstash Redis client, key conventions
  database          Drizzle schema, client, migrations, seeds
  entitlements      Feature gating logic + cache
  events            Platform event registry
  idempotency       Idempotency-key store + middleware
  logger            Structured logging with PII masking
  mcp               Model Context Protocol utilities
  notifications     Notification engine
  permissions       RBAC check logic + cache
  queue             SQS message queue abstraction
  secrets           AWS Secrets Manager integration
  storage           S3 client
  types             Shared TypeScript types
  validators        Zod schemas

products/agent-platform/packages/
  api               Agent routes, task handlers, watchdog — mounted onto foundation API
  schema            Drizzle schema for agent tables
  worker-handlers   SQS handlers for agent background jobs

infra/
  terraform/        IaC — Cognito, API GW, SQS, SNS, EventBridge, S3, IAM, secrets
  vm/               One-click dev VM (GCP/AWS) — pgvector + Redis
  monitoring/       Prometheus + Grafana stack

mcp-server/         Standalone MCP server (own package.json, npm not pnpm)
template.yaml       SAM — 6 Lambda functions
samconfig.*.toml    Per-env SAM config
bootstrap.sh        Creates S3 + DynamoDB resources before first deploy
```

---

## Workspace conventions

- **Package scope:** `@serverless-saas/<pkg>` — this is the internal npm scope, kept as-is
- **Imports between packages:** use `@serverless-saas/<pkg>` (workspace-resolved)
- **Schema barrel:** all Drizzle tables exported from `packages/foundation/database/schema/index.ts`; relations from `relations.ts`
- **Agent schema:** agent-platform tables exported from `products/agent-platform/packages/schema`
- **Route registration:** every Hono route is `app.route('/path', routeModule)` in `apps/api/src/app.ts`
- **Product mounting:** agent platform routes mount via `agentProduct.mountApiRoutes(api)`, `.mountPublicRoutes(publicApi)`, `.mountInternalRoutes(internalApi)`
- **Worker handlers:** registered via `registerHandler(type, fn)` in `apps/worker/src/router.ts`; agent product handlers register via `registerProductHandlers(registerHandler)`
- **Ops portal:** `apps/web/app/ops/(protected)/` — separate auth from tenant dashboard

---

## Services and what each does

| Service | Runtime | Deployed where | Port |
|---|---|---|---|
| `apps/api` | Lambda (SAM) | AWS ap-south-1 | — |
| `apps/worker` | Lambda (SAM) | AWS ap-south-1 | — |
| `apps/web` | Next.js (PM2) | GCP VM | 3000 |
| `apps/agent-orchestrator` | Node.js (PM2) | GCP VM | 3001 |
| `mcp-server/` | Node.js (PM2) | GCP VM | 3002 |
| `apps/ai-service` | Python (PM2) | GCP VM | 3004 |
| `apps/inference-gateway` | Node.js (PM2) | GCP VM | 4001 |

Port 3003 is unused — there is no `apps/agent-server`. The agent runtime lives inside
`apps/agent-orchestrator`.

**`./deploy.sh` does NOT deploy every VM service.** It rebuilds Next.js and restarts
exactly two PM2 processes: `web-frontend` and `api`. The orchestrator, `mcp-server`,
`ai-service` and `inference-gateway` must be restarted by hand (`pm2 restart <name>
--update-env`) — including after any env change.

**`mcp-server` and `inference-gateway` require `INTERNAL_SERVICE_KEY` to start.** Both
call `process.exit(1)` when it is unset, so a PM2 env missing it takes the service down
rather than running it unauthenticated. The value must match
`project-context/{env}/internal-service-key` in Secrets Manager, which is what the
Lambdas and the orchestrator send. Both also bind `127.0.0.1` by default
(`MCP_BIND_HOST` / `INFERENCE_BIND_HOST`) — they are not meant to be reachable off-host.

---

## Lambda functions (template.yaml)

| Function | Handler | Timeout | Trigger |
|---|---|---|---|
| `FoundationApiFunction` | `index.handler` | 29s | API Gateway HTTP |
| `FoundationWorkerFunction` | `lambda.handler` | 300s | SQS |
| `FoundationPretokenFunction` | `pretoken.handler` | 5s | Cognito pre-token |
| `FoundationWebSocketFunction` | `websocket.handler` | 29s | API Gateway WS |
| `TaskWorkerFunction` | `taskWorker.handler` | 300s | SQS (agent-task queue) |
| `WatchdogFunction` | `watchdogHandler.handler` | 120s | EventBridge rate(5 min) |

Build targets are in root `Makefile` and `apps/api/Makefile`. SAM uses `BuildMethod: makefile` — esbuild bundles each entry point into `$(ARTIFACTS_DIR)`.

---

## API middleware chain (apps/api/src/app.ts)

Applied in order on every secure request:

1. `authInjectionMiddleware` — extracts JWT from cookie/header
2. Rate limiting — 60 req/min per tenant, 20 req/min per IP
3. `userUpsertMiddleware` — ensures user row exists in DB
4. `apiKeyAuthMiddleware` — validates API key if present
5. `tenantResolutionMiddleware` — sets `c.get('tenantId')`
6. `sessionValidationMiddleware` — validates session (skipped for `/auth/me`, `/auth/tenants`)
7. `entitlementsMiddleware` — checks feature flags
8. `permissionsMiddleware` — RBAC enforcement
9. `queryScopeMiddleware` — scopes DB queries to tenantId
10. `usageRecordingMiddleware` — records usage metrics

**Registration order is enforcement order — a route only gets the middleware registered
above it.** `/onboarding` and `/invitations` are mounted deliberately between steps 3 and
4, so they run *without* tenant resolution, entitlements or permissions. That is intended
for those two, but it means adding an `api.route(...)` in the wrong place silently ships
an unprotected endpoint that still looks guarded when you read the list above. Mount new
secure routes below step 10.

For the same reason, `sessionValidationMiddleware` exemptions use the
`isSessionValidationExempt` predicate in `apps/api/src/middleware/sessionExempt.ts`, not
Hono's `except()`. `except()` matches `c.req.path`, which includes the `/api/v1` mount
prefix — patterns written without it match nothing and the exemption silently never fires.

---

## Worker job types (apps/worker/src/router.ts)

Foundation handlers:
- `notification.fire` — dispatch notification
- `notification.step` — notification workflow step
- `email.send` — SES email delivery
- `audit.write` — write audit log entry
- `cache.invalidate` — invalidate Redis cache keys
- `webhook.deliver` — webhook delivery with retry
- `usage.record` — usage aggregation
- `workflow.fire` — workflow trigger (stub — implement per product)

Agent platform handlers registered via `registerProductHandlers`.

---

## Architectural decisions worth knowing

- **Lambdalith pattern.** The entire REST API is one Lambda (`FoundationApiFunction`) with Hono routing. No per-route Lambda split.
- **SAM → Terraform contract.** SAM deploys Lambdas first, writes ARNs to SSM. Terraform reads SSM to wire API Gateway, Cognito triggers, SQS event source mappings, IAM. Always run `sam deploy` before `terraform apply`.
- **Pre-token Lambda stamps JWT.** `pretoken.ts` runs on every Cognito token issue and injects `tenantId`, `role`, `plan` as custom JWT claims. All downstream auth relies on these claims — never trust user-supplied tenantId.
- **WebSocket Lambda is live.** Unlike the foundation baseline, this project uses WebSocket for real-time task/notification push. `websocket.ts` handles `$connect`, `$disconnect`, `$default`.
- **Agent task queue is separate from processing queue.** `AGENT_TASK_QUEUE_URL` drives `TaskWorkerFunction`. The foundation processing queue drives `FoundationWorkerFunction`. Don't mix them.
- **WatchdogFunction runs on a schedule.** EventBridge fires it every 5 minutes. It marks `in_progress` tasks that have stalled as `blocked`. No manual trigger needed.
- **Agent orchestrator is Mastra-based.** `apps/agent-orchestrator` uses `@mastra/core` and `@mastra/hono`. It bridges SSE (browser chat) and WebSocket (mobile) to the `platformAgent`. Memory is per-tenant via Mastra's PostgresStore.
- **mcp-server/ (root) is canonical.** `apps/mcp-server/` was removed (duplicate). The root `mcp-server/` runs on GCP VM port 3002, uses its own npm (not pnpm), and is NOT part of the pnpm workspace.
- **Google OAuth credentials are Terraform-managed.** `google_client_id` and `google_client_secret` are Terraform input variables — they seed the `project-context/{env}/google-oauth` secret and wire Cognito's Google IdP in a single `terraform apply`. No manual seeding needed for Google.
- **These 6 secrets must be seeded manually** before `terraform apply`:
  - `project-context/{env}/gcp-sa-key`
  - `project-context/{env}/internal-service-key`
  - `project-context/{env}/token-encryption-key`
  - `project-context/{env}/jira-oauth`
  - `project-context/{env}/github-app`
  - `project-context/{env}/zoho-oauth`
- **Only `dev` exists today.** There is no staging or prod CloudFormation stack, and no
  staging or prod secrets. The 6 above must be seeded when those environments are first
  created, along with deciding `DatabaseSslNoVerify` / `DatabaseDisablePrepare` in the
  matching `samconfig.*.toml` — both currently `false`, which is correct only until the
  real topology is known.
- **`apps/api/.env` holds `FILL_IN` placeholders — treat it as incomplete, not as config.**
  `TOKEN_ENCRYPTION_KEY` is one of them. Any script that encrypts with the local env would
  write ciphertext under the literal string `FILL_IN`, which the deployed API can never
  decrypt and which re-running the migration cannot detect or undo. For anything touching
  encrypted columns, read the real key from Secrets Manager:
  `aws secretsmanager get-secret-value --secret-id project-context/dev/token-encryption-key`
- **SSM namespace is `/project-context/{env}/...`** — not `serverless-saas`. The package scope `@serverless-saas/*` is internal-only and never touches AWS.
- **Tenant routing in web.** Dashboard URLs are `/{tenantSlug}/dashboard/*`. Subdomain routing (`acme.projectcontext.co`) is handled by `apps/web/middleware.ts` via `NEXT_PUBLIC_ROOT_DOMAIN`.
- **Inference gateway proxies Vertex AI.** `apps/inference-gateway` on port 4001 is the single point for all Gemini/Vertex calls. Agent orchestrator and other services hit it via `VERTEX_PROXY_URL`.
- **pgvector required.** Use `pgvector/pgvector:pg16` not vanilla postgres for local dev. The agent platform uses vector search.
- **The database is Supabase, reached through a pooler.** Deployed environments use the
  *transaction* pooler (port 6543); local `.env` files point at the session pooler (5432).
  Same database, different connection semantics: a transaction pooler hands each statement
  to a different backend, so postgres.js named prepared statements fail under concurrency.
  `products/agent-platform/packages/api/lib/db-options.ts` disables them from configuration
  (`pgbouncer=true` in the URL, or `DATABASE_DISABLE_PREPARE`) rather than by sniffing the
  port, so each deployment declares its own topology. `db.ts` still carries a Neon code path
  (`isNeon`, a custom `neonSocket` for IPv4 resolution); it is dormant against Supabase.

---

## First-time deployment order

```bash
# 1. Create bootstrap AWS resources (one time only)
./bootstrap.sh

# 2. Seed 6 secrets in AWS Secrets Manager (see bootstrap.sh output)

# 3. Install + build
pnpm install
sam build --config-file samconfig.dev.toml

# 4. Deploy Lambdas (writes ARNs to SSM)
sam deploy --config-file samconfig.dev.toml

# 5. Fill terraform vars (Lambda ARNs come from step 4)
cd infra/terraform/foundation
cp terraform.tfvars.example terraform.tfvars  # fill in all values
terraform init -backend-config=../environments/dev/backend.hcl
terraform apply

# 6. Set up web env (Cognito IDs come from terraform output)
cp apps/web/.env.example apps/web/.env.local  # fill in values
```

---

## Useful local commands

```bash
# Build + type-check
pnpm build
pnpm type-check
pnpm lint

# Local API (SAM emulator)
sam build --config-file samconfig.dev.toml
sam local start-api

# Local dev server (Node)
cd apps/api && pnpm dev   # PORT from apps/api/.env — currently 3001, which
                          # collides with agent-orchestrator. Change one of them
                          # before running both locally.

# Database migrations
cd packages/foundation/database
pnpm exec drizzle-kit generate   # regenerate from schema
pnpm exec drizzle-kit migrate    # apply to DATABASE_URL

# SAM deploy
sam deploy --config-file samconfig.dev.toml
sam deploy --config-file samconfig.staging.toml
sam deploy --config-file samconfig.prod.toml

# Terraform
cd infra/terraform/foundation
terraform init -backend-config=../environments/dev/backend.hcl
terraform plan
terraform apply

# Dev VM (one-click Postgres + Redis)
cd infra/vm
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
terraform output env_block   # paste into .env files

# GCP VM deploy (web + PM2 services)
./deploy.sh
```

---

## Foundation vs Product rule

Before writing any new code, ask: **"Is this foundation or product?"**

- **Foundation** — works for any SaaS product, has no knowledge of PM workflows, pension records, or any specific domain. Goes in `packages/foundation/*`, `apps/api` foundation routes, `apps/web` foundation pages, or the base agent-orchestrator setup (platformAgent, memory, model, guardrails, RAG pipeline).
- **Product** — specific to `project-context` (PM workflows, PRD, roadmap, tasks, agents, board, chat, evals). Goes in `products/agent-platform/*`, product-specific agent-orchestrator agents/workflows, product-specific web pages.

This boundary stays clean until the foundation is extracted into a separate repo after the first production product ships. Don't strip it early — ship first, extract after.

---

## What NOT to do

- **Don't add product features to `packages/foundation/*`.** Foundation packages are shared. Product code goes in `apps/*` or `products/*`.
- **Don't edit core middleware for product needs.** Extend via composition.
- **Don't add tables to existing foundation schema files.** Create `schema/<your-table>.ts`, export from `index.ts`, run `drizzle-kit generate`.
- **Don't bypass tenancy checks.** Every DB query must filter by `tenantId`. The `tenantResolution` middleware sets `c.get('tenantId')`.
- **Don't use `serverless-saas` as an AWS resource name.** That was the legacy name. All AWS resources use `project-context` prefix. The `@serverless-saas/*` package scope is internal only.
- **Don't run `terraform apply` before `sam deploy`.** Terraform reads Lambda ARNs from SSM — those don't exist until SAM deploys the Lambdas.
- **Don't edit `mcp-server/` using pnpm.** It's a standalone npm project. Use `npm install` / `npm run build` inside `mcp-server/`.
- **Don't hardcode domains.** Use `NEXT_PUBLIC_AGENT_WS_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ROOT_DOMAIN` env vars in the web app.
