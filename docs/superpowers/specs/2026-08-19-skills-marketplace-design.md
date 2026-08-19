# Skills Marketplace — Design

## Problem

`agentSkills` (`products/agent-platform/packages/schema/conversations.ts`) lets a tenant hand-author a skill — name, system prompt, tool list, config — one row per agent, via `POST /agents/:agentId/skills`. That covers a single team writing its own prompt for its own agent. It does not let a tenant install something someone else built, and it does not let a tenant publish something it built for other tenants to use. There is no browse surface, no packaging format, no versioning, and no sharing boundary — every skill today is bespoke, private-by-construction, and invisible outside the agent it was created on.

## Goal

Tenants can upload, install, publish, and download reusable **skill packages** — a manifest plus resource files, distinct from the existing hand-authored `agentSkills` row shape — through a tenant-wide library that agents attach to individually. Three sources: paste a URL, import a public GitHub repo, or upload a zip. Sharing has two tiers: private (tenant-only) and public (any tenant), plus an ops-portal-settable "Official" flag with no review workflow for v1.

## Non-goals

- **Runtime wiring into an agent's live system prompt/tools.** This design gets an installed skill's package (manifest + files) into a tenant's library and lets it attach to an agent via a new `installId` FK on the existing `agentSkills` row. How that package's content actually shapes what the Mastra agent does at chat time is deliberately out of scope — the user's own words: "we have mastra already, we'll look into agent runtime later."
- **A review/approval queue for publishing or for "Official."** Both are self-serve/admin-only booleans for v1, no workflow state machine.
- **Private-repo GitHub import.** Only public repos, fetched anonymously via `codeload.github.com` tarball — no OAuth, no GitHub App installation. (`products/agent-platform/packages/worker-handlers/lib/github.ts`'s installation-token flow exists in this repo already, but it's built for a tenant's *installed* GitHub App reading *their own* private repos for a different feature — reusing it here would mean asking every tenant to grant this platform's GitHub App access just to import a public skill, which is the wrong trust model for this feature.)
- **Editing a skill package's content in-app.** Import is the only way content enters a version; there is no in-browser manifest/file editor in this pass.

## Architecture

```
Tenant (web)                                                        Other tenants (Public tab)
     │                                                                       │
     │  POST /skills (source: url|github|zip)                               │  GET /skills?tab=public
     ▼                                                                       │
apps/api  ── validates request, writes `skills` + `skill_versions`          │
     │        (status: pending), enqueues import job — no unzip/            │
     │        fetch happens in the Lambda itself                            │
     │                                                                       │
     ▼  SQS (existing publishToQueue / registerProductHandlers pattern)     │
apps/worker  ── new `skill.import` handler:                                 │
     │            - zip: safeExtractSkillZip (new, sibling to safeZip.ts)   │
     │            - github: codeload.github.com tarball, public repos only  │
     │            - url: fetch with SSRF guards, then treat as zip/tarball  │
     │          writes files under S3 skill-packages/{skillId}/{version}/   │
     │          (via existing StorageService — packages/foundation/storage) │
     │          updates skill_versions.status → ready | failed              │
     ▼
S3 (skill-packages/...)          Postgres: skills, skill_versions, skill_installs
                                                    │
                                                    ▼
                                  agentSkills.installId (new nullable FK) —
                                  attaching an installed skill to one agent,
                                  via the existing AgentSkillSection UI
```

## Data model

New file `products/agent-platform/packages/schema/skills.ts`, exported from the schema barrel:

- **`skills`** — `id, ownerTenantId, name, slug, description, visibility ('private'|'public'), isOfficial, latestVersion, createdBy, createdAt, updatedAt`.
- **`skill_versions`** — `id, skillId, version (int, auto-increment per skill), manifest (jsonb), s3Prefix, sourceType ('zip'|'github'|'url'), sourceRef, status ('pending'|'ready'|'failed'), failureReason, createdAt`. Immutable once `ready`.
- **`skill_installs`** — `id, tenantId, skillId, installedVersion, autoUpdate (bool), status ('active'|'uninstalled'), createdAt, updatedAt`. Unique on `(tenantId, skillId)`.
- **`agentSkills`** (existing, `conversations.ts`) gains a nullable `installId` FK to `skill_installs.id`. The hand-authored flow (`name`/`systemPrompt`/`tools`/`config`, `POST /agents/:agentId/skills`) is untouched — a row created that way has `installId = null`; a row created by attaching an installed skill has it set. Same table, two provenances, same as `packItems.sourceType` already does for handover packs.

## Permissions

New resource `skills` in `packages/foundation/database/seeds/role-permissions.ts`, following the existing `resource:action` string convention (`agents:read`, `handover_packs:update`, etc.): `skills:read`, `skills:install`, `skills:publish`. Seeded onto the same roles that currently hold `agents:*` — no new role is introduced.

## Components

### 1. API routes — `products/agent-platform/packages/api/routes/skills.ts` (new)

Following the `teams.ts` / `handover.ts` shape (Hono router, `hasPermission` gate per route, tenant-scoped `resolveX` helpers):

- `GET /skills?tab=mine|official|public` — `mine` = `skills.ownerTenantId = tenantId`; `official` = `isOfficial = true`; `public` = `visibility = 'public'`. Each row includes whether the current tenant has it installed (left join `skill_installs`).
- `POST /skills` — body `{ name, description, source: { type: 'zip', fileId } | { type: 'github', owner, repo, ref } | { type: 'url', url } }`. Creates `skills` + `skill_versions` (status `pending`), enqueues `skill.import`, returns immediately (202-style shape, `data.version.status: 'pending'`) — matches the "don't unzip/fetch synchronously in the API Lambda" decision, same reasoning as handover packs' own SQS-routed jobs elsewhere in this codebase.
- `POST /skills/:id/publish` — flips `visibility` to `public`. Requires `skills:publish` and ownership.
- `POST /skills/:id/install` — creates/reactivates a `skill_installs` row pinned to `skill.latestVersion`.
- `POST /skills/:id/install/update` — bumps `installedVersion` to current `latestVersion` (explicit click, per the pinned-versioning decision — no silent auto-update even when `autoUpdate` is true in this pass; `autoUpdate` is stored but not yet acted on by anything, flagged as a known no-op until a follow-up wires a check).
- `DELETE /skills/:id/install` — sets `skill_installs.status = 'uninstalled'` (soft, matches `handoverPacks`' soft-delete convention over hard delete).
- `GET /skills/:id/versions` — version history for the detail view.
- Ops-portal `PATCH /ops/skills/:id` — `isOfficial` toggle, admin-only, separate route file under the existing ops router, matching how other admin-only flags are set outside the tenant-facing router.

### 2. Import worker handler — `products/agent-platform/packages/worker-handlers/handlers/skillImport.ts` (new)

Registered via `registerProductHandlers` (`apps/worker/src/router.ts` already calls this — add `registerHandler('skill.import', handleSkillImport)` inside the product's own registration function, not a new call site in `apps/worker`).

- **zip source**: new `safeExtractSkillPackage` in `products/agent-platform/packages/worker-handlers/lib/safeSkillZip.ts` — same zip-bomb/zip-slip defenses as `lib/safeZip.ts` (entry/size/ratio caps, path-traversal rejection), but a different extension allowlist (skill packages carry `.md`, `.json`, `.yaml`/`.yml`, `.txt`, plus a handful of common resource types, not `safeZip.ts`'s PDF/DOCX/TXT set for document ingest) and a manifest requirement (`SKILL.md` must be present at the archive root or the whole import is rejected as `failed`, not silently skipped). Written as a sibling file rather than parameterizing `safeZip.ts`'s extension list, since the two callers have different risk profiles (`safeZip.ts` runs on RAG document uploads today) and this design doesn't touch that file.
- **github source**: anonymous `GET https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}` (no `github.ts` reuse — see Non-goals), extracted with the same size/entry/path-traversal guards adapted for tarball entries.
- **url source**: `isSafeHttpUrl`-style guard (the same helper `products/agent-platform/packages/api/lib/safe-url.ts` already provides for handover-pack item URLs — reused as-is: https-only, blocks private/link-local IP ranges) before fetching, then the fetched body is treated as a zip and run through the same `safeExtractSkillPackage` path. A byte-size cap on the response is enforced during streaming, not just checked from a `Content-Length` header (a header can lie).
- On success: writes accepted files to S3 under `skill-packages/{skillId}/{version}/` via `StorageService` (`packages/foundation/storage`, the same client every other file-upload path in this repo already goes through), parses `SKILL.md`'s frontmatter into `skill_versions.manifest`, sets `status = 'ready'`.
- On any failure (bad archive, missing manifest, SSRF-blocked URL, size limit): sets `status = 'failed'`, `failureReason` set to a caller-safe message, no partial S3 writes left behind (files written to a version-scoped prefix that's only referenced once status flips to `ready`, so a failed import's orphaned prefix is inert, cleaned up opportunistically rather than transactionally — matches how `packages/foundation/storage` doesn't otherwise offer multi-object transactions).

### 3. Web UI

- `apps/web/app/[tenant]/dashboard/skills/` (new) — Mine / Official / Public tabs (same tab-pill pattern as the Marketplace page), card grid, a `+` import menu with three entries (Paste URL / Import GitHub repo / Upload zip) opening the matching small form, each `POST /skills` then polling `GET /skills/:id/versions` (or the list query) until `status` leaves `pending` — same polling-a-status-field shape the existing codebase doesn't yet have a precedent for, so this introduces a small `useQuery({ refetchInterval: ... })` while status is `pending`, stopping once it resolves.
- `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection.tsx` (existing) gains a picker: alongside whatever hand-authored `agentSkills` UI already exists there, a new "Attach from library" action lists the tenant's installed skills (`skill_installs` where `status = 'active'`) and creates an `agentSkills` row with `installId` set.

## Error handling

- Import failures are visible in the UI as `status: 'failed'` with `failureReason` shown on the skill card/detail — never a silent stuck-`pending` state. No retry-on-a-timer; re-importing is a new `POST /skills/:id` version-bump call the user triggers explicitly (consistent with handover packs' "sync is user-triggered, not automatic" precedent from earlier this session).
- SSRF/zip-bomb/zip-slip rejections all resolve to `status: 'failed'` with a generic-enough `failureReason` that it doesn't leak infrastructure details (no raw internal IP or stack trace in the message shown to the tenant), while the full error is logged server-side.
- Publish/install/uninstall follow the existing `hasPermission` → 403, not-found → 404, conflict → 409 shape used throughout `teams.ts`/`handover.ts`.

## Testing

Following this codebase's existing pattern for these two kinds of logic:
- Pure extraction/safety logic (`safeExtractSkillPackage`, SSRF guard reuse): unit tests with crafted buffers/URLs, same shape as `handover-generate.test.ts` and (if one exists) `safeZip`'s own tests — zip-bomb rejected, zip-slip path rejected, missing-manifest rejected, valid package accepted with correct file list.
- Routes (`skills.ts`): `dbMock`-hoisted Hono route tests, same pattern as `teams.test.ts` — auth/permission gates, install/publish state transitions, additive-safe install-then-reinstall behavior.
- Worker handler: mock `StorageService` and the outbound `fetch` (codeload/url sources), assert `skill_versions.status` transitions correctly on success and each failure mode.

## Resolved decisions (carried over from brainstorming)

- **Sharing tiers**: private + public, Mine/Official/Public tabs, no in-between "team-shared" tier.
- **Package shape over DB-row shape**: driven by the need to support URL/GitHub/zip import, not just typed fields.
- **Install is tenant-wide first**, per-agent attachment is a separate, later step through existing `AgentSkillSection` UI.
- **Publish is self-serve**, no approval queue for v1.
- **Official is ops-portal-admin-only**, boolean, no workflow.
- **Versioning is npm-style and pinned** — installs stay on `installedVersion` until an explicit update call.
- **Import runs through the worker queue**, never synchronously in the API Lambda.
- **GitHub import is public-repos-only**, anonymous tarball fetch — no OAuth scope creep, no reuse of this repo's existing GitHub-App-installation code path (different trust model, would require tenants to grant app access for public content).
- **Hexis (github.com/Bevel-Software/Hexis) evaluated as prior art, not adopted as infra** — no relational DB in Hexis's model (a skill is a git-committed `SKILL.md`, "version" = commit history), no install/pin concept (always-latest off whatever branch), and "Official" doesn't exist in its code (it's a flat role/access-list model). This design deliberately diverges toward pinned versions and a real (if minimal) Official flag, reimplemented as plain Postgres/Drizzle/S3 rather than porting Hexis's git-native mechanics — user's own words: "if we take theirs, i think we won't be able to map clearly to our architecture."
