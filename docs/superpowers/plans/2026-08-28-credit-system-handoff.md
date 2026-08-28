# Credit System - session handoff

Written 2026-08-28 at the end of the design session. Everything below is committed on `main`.

## What exists

| Artifact | Path | Commit |
|---|---|---|
| Design spec | `docs/superpowers/specs/2026-08-28-credit-system-design.md` | d780a7a6, f9d503ff |
| Implementation plan (15 tasks) | `docs/superpowers/plans/2026-08-28-credit-system.md` | 7bd34d56 |

No code has been written. Nothing is in progress. There is no SDD ledger yet
(`.superpowers/sdd/2026-08-28-credit-system/` does not exist).

Note: `.gitignore:52` is `*.md`, so both documents were committed with `git add -f`.
Any further doc commits need the same flag.

## What the feature is

A tenant-scoped credit system replacing the two monthly quota functions that enforce
today (`checkMessageQuota`, `checkTokenQuota` in `apps/agent-orchestrator/src/usage.ts`).
Three tables plus one Postgres function (`spend_credits()`) that owns all balance
mutation; ops-editable versioned rates in `credit_rates`; estimate-then-approve on task
submission; post-debit on chat turns. It also closes a real metering hole: chat SSE turns
currently write no `usage_records` row at all.

## Decisions already made (do not re-litigate)

- Ledger alongside `usage_records`, not replacing it.
- Tenant-owned balance; `actor_id`/`actor_type` for attribution, never `user_id`.
- Pre-check plus post-debit for chat; estimate-charge-then-settle for tasks. No
  server-side reservations in v1.
- Refunds create a NEW grant; they never un-spend an old one.
- Expired grants are swept lazily under the account lock, plus a nightly job.
- Credits replace the `messages` and `llm_tokens` entitlements; the plan entitlement
  becomes the per-cycle grant size under a new `credits` feature key.
- Unlimited tenants skip the credit layer entirely - no synthetic infinite grant.
- The credit pre-check fails CLOSED on a DB error (the quota functions it replaces failed
  open). Deliberate.
- Payments are out of scope for v1; `grant_type='purchase'` exists, the webhook does not.

## Open questions the spec records (sections 13)

1. 1 credit = 1 US cent is assumed, at cost, no markup. Confirm, and say whether v1
   carries margin.
2. `job_type` values: `chat_message`, `agent_task`, `document`.
3. Trial length: 14 days is a placeholder with no product rationale.
4. Chat overdraft mitigation: threshold pre-check or per-tenant stream cap.
5. Plan credit allowances. The plan proposes free 200 / starter 2,000 / business 10,000 /
   enterprise unlimited as placeholders.
6. Fail-closed confirmation - a credits DB outage stops chat rather than serving it free.

None of these block Tasks 1-4.

## The blocker to resolve before executing

Plan tasks 2, 4, 5, 7, 12, 13 and 14 are integration-tested against a real Postgres via
`TEST_DATABASE_URL`, and their tests `describe.skipIf` without it. On this machine:

- `TEST_DATABASE_URL` is unset
- nothing is listening on 5432 or 5433
- Docker is not running
- `psql` is installed, so a local server may be installable but is not running

Without a database those tests silently skip and the SQL function - the heart of the
feature - ships unverified. Decide before dispatching Task 2:

- **(a)** start a local Postgres (`docker run -e POSTGRES_PASSWORD=postgres -p 5433:5432
  pgvector/pgvector:pg16`, or a Homebrew server) and export `TEST_DATABASE_URL`;
- **(b)** point `TEST_DATABASE_URL` at the Supabase dev database. The tests are scoped to
  fixed synthetic tenant UUIDs and truncate only those rows, but this writes to a shared
  environment and applies the migrations there early - the user should approve it
  explicitly;
- **(c)** run Tasks 1, 3, 6 (no database needed) and stop before Task 2.

## Execution

The user chose subagent-driven development. The next session should invoke
`superpowers:subagent-driven-development` with the plan path, and:

1. Create a worktree - the repo is on `main` and this session did not have consent to
   implement there. Existing worktrees live under `.claude/worktrees/` and `.worktrees/`;
   `git worktree list` before creating another.
2. Resolve the database question above.
3. Run the pre-flight conflict scan the skill requires, then dispatch Task 1.

## Repo facts worth carrying

- `./deploy.sh` restarts only `web-frontend` and `api` on the VM. The orchestrator needs
  `pm2 restart agent-orchestrator`.
- Stale `dist/` in foundation and product packages makes `sam deploy` report "no changes"
  while shipping old code. Rebuild before deploying.
- The deployed database is Supabase behind the transaction pooler (6543); named prepared
  statements are disabled by configuration. `spend_credits()` is called as a single
  statement precisely so no transaction spans two backends.
- `git status` before every commit - this repo often carries unrelated WIP.
