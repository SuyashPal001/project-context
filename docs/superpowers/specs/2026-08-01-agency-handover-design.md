# Project Context — Agency Handover: Scoped Vision

**Date:** 2026-08-01
**Status:** Approved scope, pre-build
**Supersedes:** the "AI engineering team" positioning on the current marketing site

---

## One line

Project Context is a delivery workspace for software agencies where the client
handover writes itself, because the workspace was present while the work was
defined.

---

## Who it's for

Software agencies and dev shops, roughly 10–50 people, doing client project
work. Not in-house engineering teams, not product managers, not DevOps, not
creatives — see "Positions ruled out" below.

The founder runs an agency doing both client work and own products. That makes
him ICP zero: the first measurement and the first case study come from his own
client projects.

Agencies are also *listable* — Clutch alone yields hundreds with contact
details. For a solo founder with no network, reachability decides the go-to-
market, and it points the same way.

---

## The problem

Client handover takes **a week per project, unbilled**. At agency blended rates
that is $2,000–6,000 of cost on every project, forever.

The week is not spent assembling a folder. It is spent *writing the
documentation*: what got built, why the decisions were made, how it works, what
was tried and rejected. All of that existed during delivery and was never
captured in a usable form, so it gets reconstructed by hand at the end.

Market data puts typical agency handoff admin at 3–5 hours per project. Software
handover runs 8–10x that, because the knowledge is technical and undocumented.
Existing tools are built for the light case.

---

## The product

Three stages, each earning the next.

**1. RFP in.** Upload the client brief. The agent drafts scope, milestones, and
an estimate. The human edits it. That edit becomes the immutable starting point
of the project — the top of the provenance chain.

**2. Delivery.** Sequenced board, agents assist, client sign-off at each gate.
Every change carries provenance: raw input → AI draft → human edit → approval.

**3. Handover out.** A pack containing what was built, why decisions were made,
how it works, and **every delta from the original RFP**. Client-branded,
delivered by signed link.

That third artifact is scope defense, not just documentation. It justifies the
final invoice and ends the "we thought this was included" conversation — which
makes the agency want it for itself, not only because the client asked.

---

## Why it holds

Verified 2026-07-31 / 2026-08-01 by market search.

| Player | Covers | Gap |
|---|---|---|
| Finalizo, SuperOkay | Handover *envelope* — checklist, credentials, sign-off | Doesn't write the contents |
| Vyntro, Penna, Taskade | Brief → scope → proposal → signature | Stops at signature |
| Unblocked, Glean | Indexes artifacts that already exist | Can't produce what was never written down |
| Kiro, Tessl, Spec Kit | Spec → code | Starts at the spec, ends at the code |

Nobody carries one project end to end. Producing the handover contents requires
having been present when the decisions were made — which cannot be retrofitted.

**Tagline:** *Project Context — the handover writes itself.*

---

## Pricing

- Free for collaborators and clients — most seats stay free.
- Metered on agent work.
- Charged **per project closeout**, at the moment the agency is invoicing their
  client.

A few hundred dollars against $2–6k of displaced cost is an easy yes. Note that
per-*activation* pricing only works because the product is already installed
from project start — the RFP intake is what gets it installed.

---

## Current state

Deployed and live at projectcontext.co. Signup and onboarding work end to end,
unassisted. Multi-tenancy, per-tenant branding, approval gates, audit log,
evals, and the embeddable widget all exist — built for other reasons, but they
land better here than anywhere else. An agency running 8 client workspaces is
the only ICP for which multi-tenancy is a feature rather than plumbing.

**Open question:** is agent output good enough for a client-facing deliverable?
A handover pack is a different bar from an internal draft. The founder's own
next client project answers this.

---

## Launch blockers

1. **Billing is not wired.** Schema exists (`subscriptions`, `invoices`,
   `payment_methods`, `billing_providers`, `usage_records`); no provider behind
   `apps/api/src/routes/billing.ts`. The pricing model requires it. Moves from
   post-launch to blocker.
2. **No error tracking.** No Sentry in web, api, or orchestrator.
3. **No CI.** Vitest *is* configured (4 packages, 10 test files, root
   `pnpm test` wired) — but coverage is thin and nothing runs it on push, so
   every deploy is unverified.
4. **Audit-log concurrency bug** — needs `SELECT FOR UPDATE` in
   `products/agent-platform/packages/api/services/audit-log.ts`.

---

## Build order

**Track A — product**

1. `clients` table under tenant (id, tenant_id, name, slug, brand fields,
   status); `project_plans.client_id`. Per-client branding overrides the
   tenant-level `brandName` / `logoUrl` / `brandColor` on `tenants`.
2. `agent_tasks`: add `conversation_id`, `source_message_id`, and an immutable
   `raw_input`. Today `description` is a single mutable column — when a human
   edits the AI draft, the draft is gone, so the diff the whole positioning
   rests on cannot be produced.
3. `task_revisions` — copy the shape from saarthi-ai's `training_examples`
   (`original_content`, `corrected_content`, `was_edited`, `reviewer_id`,
   `reviewed_at`).
4. Timeline / diff view on the task. The demo asset and the launch GIF.
5. RFP ingest: upload → draft scope + estimate → capture the human edit. File
   upload and a pointer, roughly a day. **Not** a proposal generator.
6. `handover_packs` (id, tenant_id, client_id, plan_id, status) + client-facing
   signed link, following the existing `widget/[tenantId]/[agentId]` pattern.
   Clients are not users.
7. Batch API + prompt caching in `apps/inference-gateway`.

**Track B — validation, starting immediately, not after Track A**

1. Measure own handover on the next client project: hours before vs. hours with
   the product. One number.
2. Ten agencies off Clutch (10–50 people, custom software, US/UK/EU). Five
   past-tense questions. The signal: can they state their handover hours from
   memory, and do they maintain a manual template?

**Track C — blockers**

Sentry, CI (`type-check` + `lint` + `test`), Stripe wiring, audit-log fix.

---

## Launch

Product Hunt, **after the number from Track B exists.** First comment leads with
it: *"Client handover used to take us a week. Now it takes an hour."*

Expect **150–300 upvotes**, top 5–15 of the day. RunEvr — an agentic PM
workspace for creatives — launched 2026-07-22 and landed 200 upvotes at #6.
2026 winners sit at 500–613. The category does not spike on PH.

Treat PH as a **credibility artifact**, not the acquisition channel: a badge,
backlinks, and something to reference in cold email. The channel is Clutch
outreach.

---

## Positions ruled out

Each was tested against the market and found occupied.

| Position | Occupied by |
|---|---|
| AI engineering team | Devin, Factory, CrewAI |
| Spec / context layer for coding agents | Unblocked ($20M), Tessl, AWS Kiro, GitHub Spec Kit |
| PRD generator | ChatPRD — 100k users, $15/mo, bootstrapped |
| Decision provenance ("git for intent") | decisionlog.ai, Elium |
| Capturing decisions in chat | Slack / Salesforce, natively since Jan 2026 |
| Creatives | RunEvr |
| DevOps / platform | Most crowded of all — $2B+ IDP market, 474-tool list |
| Enterprise doc/support intelligence | DevRev — 1,000+ customers, $1.15B, needs a sales team |

---

## Explicitly not doing

- **AI proposal generation as the headline.** 16+ tools compared in a single
  2026 roundup. RFP ingest is the front door, never the promise.
- **Per-tenant fine-tuning.** A 50-engineer company ships 200–500 tasks a
  quarter — not enough to train on, and frontier models improve faster than a
  per-tenant LoRA. The moat is a per-tenant **eval set + provenance corpus**,
  which is true, defensible, and portable across model generations.
- **Vertical agents** (ServiceNow, SAP, Salesforce). Enterprise sales motion,
  9–12 month cycles, and the platform vendor owns the data and the channel.
  2028 conversation.
- **`organization_id` above `tenants`.** Agency = tenant; clients live below it.
  Inserting a layer above `tenantId` means re-plumbing the pre-token Lambda and
  all ten middleware steps, and would turn "show me all my projects" into a
  cross-tenant query. Add `organizations` later only if agency networks or
  hard-isolated clients appear; nothing here forecloses it.
- **Self-hosted GPU inference.** At $200–500/project revenue, inference is under
  1% of cost — Opus 5 runs ~$2.25 per handover, Haiku 4.5 ~$0.45. Batch API
  (50% off) and prompt caching are the real levers. Modal earns its place later
  for serving fine-tuned checkpoints or the GPU-bound `ai-service`, behind the
  existing `inference-gateway` abstraction.
- **saarthi-ai**, until distribution is solved here. Its thesis is validated by
  DevRev, but that market is enterprise-sales-gated and that motion is not
  available to a solo founder without capital.

---

## What has to be true

**Agencies eat roughly a week per project on handover and can name that number
from memory.**

The founder can. Ten others need to say the same thing. If they say four hours
and bill it, the wedge is wrong and scoping becomes the product instead.

---

## Open items

- Agent output quality against a client-facing bar — resolved by the founder's
  next client handover.
- Whether the deploy checklist items (SES production access, WAF, backups,
  uptime monitoring) are outstanding or done-but-unticked.
