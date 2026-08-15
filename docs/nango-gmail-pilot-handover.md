# Nango Gmail Pilot — Handover (2026-08-15)

**Status: core flow verified working end-to-end.** A real Gmail account
was connected through the actual `apps/web` UI, the webhook correctly
wrote a status row for the real tenant, and the UI reflects "Connected."
Two things remain before this pilot is fully closed out — see "What's
left" below.

Background: `docs/superpowers/specs/2026-08-11-nango-gmail-migration-design.md`
(design) → `docs/superpowers/plans/2026-08-11-nango-gmail-migration.md`
(the 9-task implementation plan, all tasks complete) →
`docs/nango-connector-runbook.md` (the pattern + gotchas for adding the
*next* provider — read this before starting Jira/Zoho/etc.) → this doc
(tonight's Task 9 live-verification session specifically).

---

## What's actually deployed where

Three separate deployments, each needing its own build/deploy process —
this tripped up tonight's session repeatedly, don't assume one deploy
covers all of them:

| Component | Where | How to deploy | Confirmed working |
|---|---|---|---|
| Nango itself | `nango-shared-infra` VM (`nango.projectcontext.co`, `connect.projectcontext.co`) | `docker compose up -d` on that VM | ✅ |
| `apps/api` | AWS Lambda `project-context-foundation-api-dev`, region `ap-south-1` | `sam build --config-file samconfig.dev.toml FoundationApiFunction` then `aws lambda update-function-code` directly (see below — `sam deploy` for the *whole* stack currently fails on unrelated functions) | ✅ |
| `apps/web` + `mcp-server` | A separate VM (PM2), reached via `deploy.sh` for the frontend, `pm2 restart` for `mcp-server` | `git pull` then `./deploy.sh` on that VM | `apps/web` ✅ verified; `mcp-server` deployed but **its actual tool-calling has not been tested with a real connection yet** |

### Deploying `apps/api` (Lambda) — the exact working sequence

`sam deploy` on the full stack fails: `TaskWorkerFunction` and
`FoundationPretokenFunction` hit Lambda's 250MB unzipped size limit
(unrelated to this pilot — some other dependency bloat), which rolls back
the *entire* CloudFormation stack including `FoundationApiFunction`'s
otherwise-fine deploy. Until that's fixed separately, deploy `apps/api` by
targeting the Lambda directly, bypassing CloudFormation:

```bash
cd project-context  # repo root, correct branch checked out
sam build --config-file samconfig.dev.toml FoundationApiFunction
cd .aws-sam/build/FoundationApiFunction
zip -r -q /tmp/foundation-api-dev.zip . -x "*.map"
aws lambda update-function-code \
  --function-name project-context-foundation-api-dev \
  --zip-file fileb:///tmp/foundation-api-dev.zip \
  --region ap-south-1
aws lambda wait function-updated \
  --function-name project-context-foundation-api-dev --region ap-south-1
```

Env vars are separate from code — set via `aws lambda update-function-configuration`
with a full `{"Variables": {...}}` file (never `--environment Variables={...}`
inline, it echoes every existing secret into your shell history/output).
`NANGO_HOST`, `NANGO_SECRET_KEY_PROJECT_CONTEXT`, `NANGO_WEBHOOK_SECRET`
are already set correctly on this Lambda as of tonight.

---

## What's left

1. **Verify `mcp-server` can actually use the connection** — send or read
   a real Gmail message through an agent conversation (or however
   `mcp-server`'s tools get triggered in practice). This is the one part
   of the pipeline never actually exercised tonight — everything up to
   "webhook writes a status row" is proven, but nothing has called
   `getGmailAccessToken` → `GMAIL_SEND_EMAIL`/etc. against a real
   connection yet. If this fails, check `mcp-server`'s own logs on its VM
   first (not the Lambda — `mcp-server` is a separate process).

2. **Rotate the Nango dashboard password** — the credential exposed in a
   screenshot at the very start of this whole thread. Generate a new long
   random value, set it as `NANGO_DASHBOARD_PASSWORD` in
   `nango-shared-infra`'s `compose/.env` on that VM, `docker compose up -d
   nango-server` to pick it up. Confirm the old value no longer works and
   the new one does (try registering a throwaway test integration).

---

## Bugs found and fixed tonight (chronological, for context if something regresses)

All committed to the `nango-gmail-pilot` branch in `project-context`
(commits `e4fb887` → `902397c`) and, where relevant, to
`nango-shared-infra`'s `worktree-nango-gmail-pilot` branch. Full detail on
each is in `docs/nango-connector-runbook.md`'s gotchas section — this is
just the list:

1. API Gateway's catch-all JWT authorizer blocked the webhook route (no
   exception existed for it) — fixed in `infra/terraform/foundation/main.tf`.
2. `connect.${DOMAIN}` string-concatenation produced the wrong hostname
   since `DOMAIN` was already a full hostname, not a bare apex — fixed
   with a dedicated `CONNECT_DOMAIN` env var.
3. Cloudflare was proxying `nango.`/`connect.` subdomains (should be
   DNS-only) — was silently serving Cloudflare's own wildcard cert
   instead of Caddy's real one.
4. `openConnectUI()` doesn't inherit `host` from the `Nango` client
   constructor — was silently targeting Nango Cloud instead of this
   self-hosted instance.
5. Nango's `/connect/sessions` response is `{ data: { token } }`, not
   flat `{ token }` — misreading it produced a literal `undefined` token
   sent to the Connect UI.
6. The `credentials_enc`/`created_by` nullable-columns migration was
   verified against a local Postgres in code review but never actually
   applied to the real dev database — every webhook insert failed on a
   `NOT NULL` violation until this was run directly against the real DB.
7. The webhook handler read `payload.connectionId` (Nango's own internal
   connection ID) as the tenant ID, instead of `payload.endUser.endUserId`
   (which actually carries the `tenantId` we set as `end_user.id` when
   creating the session) — every insert failed on a `foreign_key_violation`
   against a `tenant_id` that matched no real tenant.

## Debugging tools that worked, for next time

- **CloudWatch logs directly** (`aws logs filter-log-events --log-group-name
  /aws/lambda/project-context-foundation-api-dev --filter-pattern "..."`)
  resolved things much faster than guessing from browser DevTools once the
  browser extension (`claude-in-chrome`) failed to connect all night —
  worth trying this route first if it happens again.
- **Direct `psql` against the real `DATABASE_URL`** (pulled from the
  Lambda's own env config, never printed to chat) — the only way tonight's
  actual root causes got confirmed, rather than guessed at.
- Nango's own source, cloned locally at `/Users/suyash/Desktop/projects/nango`
  (kept up to date — `git pull --rebase` — during tonight's session) was
  essential for confirming exact API response shapes and webhook payload
  fields against ground truth instead of stale/summarized docs.
