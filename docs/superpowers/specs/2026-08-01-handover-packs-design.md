# Handover Packs — Spine Design

**Date:** 2026-08-01
**Status:** Approved, pre-plan
**Parent:** `2026-08-01-agency-handover-design.md` — Track A item 6
**Depends on:** `2026-08-01-agency-handover-track-a-schema.md` Tasks 3–5 (`task_revisions`,
provenance write path, migrations `0044`–`0046` applied)

---

## Goal

A client handover pack that is a **projection of the delivery workspace**, not a
document someone typed. The agency builds a pack against a project plan, reviews
it, sends one tokenised link, and the client signs it.

Five sections — delivered items, credentials, training materials, support
boundary, client sign-off — and a four-step flow: build, review, send, sign.

Finalizo and SuperOkay ship the same five sections. The difference is
`pack_items.source_type` / `source_id`: every record knows whether a human typed
it or it was derived from a task, a milestone, or a file. Those two columns are
what make agent auto-fill (spec 2) possible without forking the data model.

---

## Decomposition

This is four subsystems with four different failure modes. They ship as separate
specs. Only the spine is load-bearing:

```
             ┌─────────────────────┐
             │  THE SPINE (this)   │   packs, sections, items,
             │  handover_packs     │   builder UI, client portal,
             │  pack_items         │   draft→sent→signed
             └──────────┬──────────┘
      ┌─────────┬───────┼────────┬──────────┐
 Credentials  Sign-off  PDF   Auto-fill  Resource Hub
 (security)  (legal)  (infra)  (agent)   (files)
```

- **Credentials** is a security subsystem: encryption at rest, reveal controls,
  audit-on-reveal.
- **Certificate** is a legal-record subsystem: frozen snapshot, content hash,
  certificate ID.
- **PDF** is an infra subsystem: nothing in the repo renders PDF today, and the
  API Lambda's 29s timeout means a render pipeline cannot live there — it goes
  to the worker Lambda (300s) or the GCP VM.
- **Auto-fill** is an agent subsystem, and is spec 2.

## In scope

1. `handover_packs`, `pack_sections`, `pack_items` (migration `0047`).
2. Builder UI at `/{tenant}/dashboard/plans/[planId]/handover`.
3. Client portal at `/p/[token]` — public, unauthenticated, tokenised.
4. Lifecycle `draft → sent → signed`, plus `revoked`.
5. Readiness checklist (the "7 of 9 complete" view), computed.

## Out of scope, and why the order is this way

- **Credentials.** A bare URL token is adequate for "here is what we delivered"
  and inadequate for a DNS password. The Credential spec must first harden the
  portal's auth model — email-code verification, per-reveal audit — before any
  secret sits behind that link. The `credentials` section kind exists in the
  enum from day one so it slots in without a migration.
- **Certificate and PDF export.** Signing here sets a status and locks editing.
  It does not yet produce a hashed immutable snapshot or a certificate ID.
- **Agent auto-fill.** The provenance columns land now; nothing calls an agent.
- **Selectable templates.** Finalizo's create dialog offers a template picker
  ("Web Design Handover"). There is exactly one built-in template here — the five
  sections — so the picker is omitted rather than shipped with one option.
  `seedSections()` is the seam a template library plugs into later.
- **Email-code verification and link expiry on the portal.** Credential-spec work.

Because auto-fill is next, **every item is editable from the moment it exists**.
There is no "generated, therefore locked" state. Generation writes rows, humans
edit rows, an edit is an update. The two paths never fork.

---

## Data model

New file `products/agent-platform/packages/schema/handover.ts`. Migration
`0047_handover_packs.sql`, hand-written per the Global Constraints in the Track A
schema plan (no `db:generate`, no snapshot, idempotent DDL, no `DROP`).

```
handover_packs
  id, tenant_id → tenants, plan_id → project_plans, client_id → clients (nullable)
  title                     "Bloom Studio Redesign"
  scope_summary             "5-page Webflow site with CMS blog"
  delivery_date             timestamp
  prepared_by → users
  recipient_name            "Rebecca Chen"     -- who the pack is sent to
  recipient_email                              -- the send target; `clients` has
                                               -- no email column and gains none
                                               -- here, since the contact can
                                               -- differ per project
  status                    pack_status: draft|sent|signed|revoked
  token_hash                text, unique
  sent_at, signed_at
  signed_by_name, signed_by_email              -- who actually signed, which may
                                               -- not be the recipient
  created_at, updated_at, deleted_at
  UNIQUE (plan_id) WHERE deleted_at IS NULL

pack_sections
  id, tenant_id, pack_id → handover_packs (cascade)
  kind        pack_section_kind: delivered|credentials|training|support|signoff
  title       "Delivered items"
  subtitle    "Everything delivered, grouped by outcome."
  eyebrow     "PROJECT CLOSEOUT"
  sort_order, is_visible
  UNIQUE (pack_id, kind)

pack_items
  id, tenant_id, pack_id, section_id → pack_sections (cascade)
  title            "CMS collections"
  description      "Blog posts, case studies, testimonials..."
  status_label     "Complete"       -- green chip
  category_label   "Delivered"      -- grey badge
  source_type      pack_item_source: manual|task|milestone|file
  source_id        uuid, nullable
  file_id → files  nullable
  url              text, nullable
  sort_order, created_at, updated_at
```

**`token_hash`, not `token`.** The token is returned once at send and never
stored in plaintext, so a database read does not hand over every client portal.
Lookup is by hash.

**`UNIQUE (plan_id)` partial index.** One live pack per project. Two half-built
packs for the same client is the obvious support failure. Revoke-and-recreate is
the escape hatch.

**`source_id` carries no foreign key.** It points at three different tables
depending on `source_type`. `agent_tasks.milestone_id` / `plan_id` already do
this and document why (circular imports); this follows the precedent rather than
inventing a polymorphic scheme.

**`status_label` and `category_label` are free text, not enums.** The observed
vocabulary is `Delivered`, `Passed`, `Complete`, `Encrypted`, `Connected`,
`Video`, `Guide`, `Reference`, `30 days`, `Billable`, `Agreed`, `Signed`,
`Exported`, `Issued` — and it varies per agency. Constraining it means a
migration per customer.

Branding resolves through `resolveBranding(client, tenant)` from
`products/agent-platform/packages/api/lib/branding.ts` (Track A Task 1).

---

## API surface

New file `products/agent-platform/packages/api/routes/handover.ts`, mounted
`api.route('/handover', handoverRoutes)` in `mountApiRoutes`.

**Authenticated (agency side)** — full middleware chain, `tenantId` from
`c.get('tenantId')`, every query filtered by it:

```
POST   /handover/packs                     { planId, title, scopeSummary, deliveryDate,
                                             recipientName?, recipientEmail? }
                                           creates pack + seeds 5 sections
GET    /handover/packs/:id                 pack + sections + items
PATCH  /handover/packs/:id                 title, scopeSummary, deliveryDate,
                                           recipientName, recipientEmail
GET    /handover/packs/:id/readiness       the checklist
PATCH  /handover/packs/:id/sections/:sid   title, subtitle, eyebrow, sortOrder, isVisible
POST   /handover/packs/:id/items
PATCH  /handover/packs/:id/items/:itemId
DELETE /handover/packs/:id/items/:itemId
POST   /handover/packs/:id/send            mints token, status→sent, queues email.send
                                           to recipient_email, returns the full URL
                                           exactly once. 422 if readiness is incomplete.
POST   /handover/packs/:id/revoke          status→revoked, portal 404s immediately
```

**Public (client side)** — registered in `mountPublicRoutes`, no auth chain:

```
GET  /packs/:token          read-only pack projection
POST /packs/:token/sign     { name, email } → status→signed, records signer
```

Two invariants enforced at the route layer, not by UI discipline:

- **Once `status = 'signed'`, every mutating endpoint returns 409.** The pack is
  a record from that point. Spec 3 adds the hash; the lock must exist from the
  start or packs signed in the interim are worthless.
- **Readiness is computed, never stored.** Derived from pack state: delivery date
  set, scope summary non-empty, `recipient_email` present, and each visible
  section holding at least one item. A stored checklist drifts the moment an item
  is deleted. `/send` refuses (422) while readiness is incomplete, so the
  checklist is a gate rather than decoration.

---

## Portal security model

The token is the entire credential.

- **32 random bytes, base64url** (43 chars) from `crypto.randomBytes`. Finalizo's
  `/p/bloom-studio-aBc12` is roughly five characters of entropy and is
  brute-forceable.
- **Stored as sha256 only.** Returned once on send. A lost link is re-sent, which
  mints a fresh token and invalidates the old one.
- **`draft`, `revoked`, and soft-deleted packs return 404, not 403.** A 403
  confirms the pack exists.
- **No `tenantId` in the URL.** Unlike `/widget/:tenantId/:agentId`, the token
  alone resolves the tenant. Nothing about tenancy is inferable from the link.
- **The public projection is a whitelist**, not the internal row minus fields. No
  `source_id`, no user IDs, no internal task references, no tenant metadata. The
  client sees title, description, the two labels, and file/URL links. File links
  are S3 pre-signed at read time via the existing storage client.
- Rate limiting: the existing 20 req/min per IP covers the public router.

---

## UI

**Builder** — `apps/web/app/[tenant]/dashboard/plans/[planId]/handover/page.tsx`

Two panes: a left rail of five section cards showing record count and a progress
bar, and a right pane editing the selected section's items inline. Above it, the
readiness checklist with its percentage, and a Send action disabled until
readiness is complete. Pack creation (project name, recipient, delivery date,
scope summary) is a dialog, not a page.

**Portal** — `apps/web/app/p/[token]/page.tsx`

Server component; fetches server-side, touches no auth cookie. Same left-rail
layout, read-only, branded via `resolveBranding`. Sign-off is a form at the end
of the final section: name, email, confirm.

Both reuse the dark-surface card patterns already in `dashboard/board` and
`dashboard/plans`. No new design language.

---

## Testing

Pure-unit with `vi.mock`, no database, matching
`products/agent-platform/packages/api/__tests__/tasks.state.test.ts`. Three pure
modules get real TDD:

- `lib/handover-template.ts` — `seedSections(packId, tenantId)` returns the five
  section rows with default copy and ordering.
- `lib/handover-readiness.ts` — `computeReadiness(pack, sections, items)` returns
  `{ checks[], complete, total, pct }`.
- `lib/pack-token.ts` — `mintToken()` / `hashToken()`. Tokens are 43 chars,
  unique across repeated calls, and the raw value is never returned by any
  read path.

Routes are covered by `pnpm type-check` plus the existing suite. Migration `0047`
is verified by the same `grep -c DROP` and table-name checks used for
`0044`–`0046`.

---

## Sequencing

Track A schema plan Tasks 3–5 land first — `task_revisions`, the provenance write
path, and migrations `0044`–`0046` applied to the database. This spec's migration
is `0047` and assumes `clients` and `project_plans.client_id` exist.

---

## What has to be true

**An agency will send this link to a real client instead of an email with
attachments.** The founder's next client project is the test: build the pack in
the product, send the link, and measure the hours against the current manual
handover. That number is the Track B input and the Product Hunt first comment.

If the pack has to be heavily rewritten by hand before it is presentable, the
problem is content quality, and spec 2 (auto-fill) becomes the priority over
credentials and PDF.
