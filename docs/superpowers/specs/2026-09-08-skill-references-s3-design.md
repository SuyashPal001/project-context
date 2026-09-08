# Skill reference-file support (S3 + Mastra dynamic skills)

Date: 2026-09-08
Status: draft — Open Questions 1 and 2 now have decisions (see below);
Q3 (S3 credentials) and the exact scope of Q2's "teach mode" toggle are
still open. Needs one more review pass before planning.

Split from `2026-09-08-skill-quality-and-references-design.md`. The
quality-bar half of that doc is independent and safe — see
`2026-09-08-skill-quality-bar-design.md`, already approved for planning.

## Problem

The import worker (`skillImport.ts:106-118`) already uploads every accepted
file in a zip/github/url package to S3
(`skill-packages/{skillId}/{version}/{fileName}`), including anything under
`references/` — `.md` is a supported extension and subdirectories survive
`stripCommonRoot`. But `skillVersions.manifest` — the only thing any runtime
code reads — only ever gets `{ ...frontmatter, body }`. Nothing downstream
(`usage.ts:fetchAgentSkills`, `platformAgent.ts`'s `instructions` function)
reads anything else. Reference files sit in S3, fully uploaded, permanently
unread by any agent.

## Goal

A skill's reference files are readable by the agent that has it attached —
on demand, not force-injected, with zero regression to today's
guaranteed-every-turn behavior for the main skill body.

## Non-goals

- Letting a user attach reference files at *creation* time through the
  dashboard modal or the in-chat `create_skill` tool. This is
  **runtime-read-only**: it makes references work for any skill whose S3
  package already has them (zip/github/url imports), not for hand-authored
  single-file skills.
- Migrating the main skill *body* off the force-inject path in
  `fetchAgentSkills`/`platformAgent.ts`. It keeps working exactly as today —
  this is additive.
- A bespoke `read_skill_reference` tool. Rejected in the prior review round:
  it would duplicate Mastra's own `skill_read`, with a security surface
  (name collisions, version pinning) we'd have to hand-roll for no benefit
  over what the library already does correctly.
- A sub-agent-per-skill execution model — `skill_read` already isolates a
  reference's context cost to the turn it's read, without a second model
  round-trip. Not revisited here.

## What changed from the previous draft (and why)

An Opus review of the first combined spec found three concrete errors,
verified against code, not opinion:

1. **False security claim.** The previous draft said the new resolver's join
   "mirrors exactly what `fetchAgentSkills` already does." It doesn't —
   `fetchAgentSkills` (`usage.ts:72-79`) runs a flat, joinless
   `SELECT name, system_prompt, install_id, version FROM agent_skills WHERE
   agent_id = $1 AND tenant_id = $2`. There is no existing join to `skill_installs`
   or `skill_versions` to mirror. The resolver's join is genuinely new
   security surface and must be reviewed as such, not waved through as "the
   same as before."
2. **Body/reference version drift, previously unaddressed.** `agent_skills.system_prompt`
   is a denormalized copy of a skill's body, written once at attach time (or
   reconciled on a later re-attach — see `agent-skills.ts`'s 23505 handling).
   `agent_skills.version` is explicitly documented in that same file as "a
   display/order field, not a reflection of the install's version." If a
   tenant upgrades their pinned `skill_installs.installed_version` without
   re-attaching, the cached `system_prompt` (body) silently goes stale
   relative to the live pin — this is a **pre-existing property of the
   system**, not something this design introduces. But a references resolver
   that reads live from `skill_installs.installed_version` would then show
   references from a *newer* version than the stale cached body describes —
   a real correctness gap if not decided explicitly (see Open questions).
3. **Unmeasured "no extra cost" claim.** The previous draft asserted
   `skill_read` cost "lands only on the turn it's read, not charged against
   `MAX_COMPOSED_SKILL_CHARS`." True for the accounting, but Mastra's own
   `SkillsProcessor` injects an `<available_skills>` catalog block (name,
   description, location, source) into **every turn** once any skill
   resolves, plus three tool schemas (`skill`, `skill_search`, `skill_read`).
   That's a real, currently unmeasured per-turn token cost that exists
   independent of whether any reference is ever actually read. This must be
   measured before shipping, not assumed away.
4. **Missing dependency, unstated.** `apps/agent-orchestrator` has no AWS SDK
   dependency today (no `@aws-sdk/client-s3` in its `package.json`). The
   resolver needs one, plus AWS credentials reachable from the GCP VM it runs
   on (not Lambda — a different credential story than the API side), plus a
   caching plan, since a naive per-turn `ListObjectsV2` + N `GetObject` calls
   for every active skill on every turn is real added latency.
5. **`createSkill` input constraints, unstated.** Per `@mastra/core/skills`
   types, `createSkill({name})` requires 1-64 lowercase-and-hyphen
   characters, and throws on violation. `agent_skills.name` is free text
   today (e.g. `"Ad Creative"`) — passed straight through, this throws and
   breaks the chat turn for that agent. Needs normalization (the existing
   `slugify()` in `skills.ts:35-37` is the obvious candidate — reuse, don't
   reinvent) before it reaches `createSkill()`.

## Decisions carried over from the prior draft (still stand)

| Question | Decision |
|---|---|
| Where do references live | S3, at the existing `skill-packages/{id}/{version}/` prefix — no new storage, no jsonb duplicate |
| How does the agent read them | Mastra's native `createSkill({ instructions, references })` via a dynamic `skills:` resolver on `platformAgent`, same `{ requestContext }` shape `instructions`/`tools` already use |
| Agent-facing description source | `manifest`'s parsed frontmatter description — never `skills.description` (the raw dashboard column). This was always a requirement on the *new* resolver code (nothing existing violates it today, since no resolver exists yet) |

## Open questions

1. **Version consistency — DECIDED: (a).** Resolver reads references from
   the *same* version the cached body reflects. `agent_skills` does not
   currently store which version `system_prompt` was resolved from (only
   the non-authoritative `version` display field) — this decision requires
   adding a new column (e.g. `resolved_version` or similar name TBD at
   planning time) written once at attach/reconcile time, alongside
   `system_prompt`. Do not repurpose the existing `version` field — it is
   documented elsewhere as a display/order field and other code may already
   depend on that meaning.
2. **Per-turn catalog cost — DECIDED: gated behind an explicit "teach mode"
   toggle**, not an automatic heuristic. The `skills:` resolver (and the
   `<available_skills>` catalog injection + `skill`/`skill_search`/
   `skill_read` tool schemas that come with it) only runs when teach mode is
   on for the relevant scope. When off, behavior is unchanged from today:
   no resolver, no catalog injection, no reference access — body-only,
   force-injected, same as now. Still open, needed before planning:
   - **Scope of the toggle** — per-agent setting (sticky across every chat
     with that agent) vs. per-conversation toggle (flips for one session
     only, same agent stays cheap elsewhere). Not yet decided.
   - The per-turn cost still needs an actual measurement once teach mode is
     on, even though it's no longer paid by default — a "how expensive is
     it when a user actually turns this on" number, not just "we've hidden
     it behind a flag so it doesn't matter."
3. **S3 access from the orchestrator VM.** Still open. Confirm what
   credential mechanism is available/intended (instance role vs. explicit
   key vs. Secrets Manager, per this repo's usual pattern) before picking a
   dependency and client setup — this is infra work, not just an npm install.
4. **Caching.** Since a specific `(skillId, version)`'s S3 objects are
   immutable once `status = 'ready'` (a new version gets a new prefix), a
   cache keyed on `(skillId, version)` with no TTL is safe and removes the
   per-turn S3 round-trip after the first read. Confirm this is in scope for
   the first implementation or explicitly deferred with the latency cost
   accepted for v1. **Precedent check:** deepseek-harness (deepseek-ai's
   open-source agent harness, `docs/architecture.md`'s Session log section)
   relies on the identical invariant for its own durable session
   generations — "committed generation paths are never renamed, replaced,
   or deleted" — and caches on that basis. Same reasoning applies here;
   this is not a shortcut, it's the standard move for content that's
   immutable-by-construction once published.

## Architecture (unchanged mechanism, now scoped around the open questions above)

```
CREATION / STORAGE (already built, unchanged)
--------------------------------------------------------------------
worker: skillImport.ts
  - uploads EVERY package file to S3:
      skill-packages/{skillId}/{version}/SKILL.md
      skill-packages/{skillId}/{version}/references/platform-specs.md
      skill-packages/{skillId}/{version}/references/generative-tools.md
  - manifest = { ...frontmatter, body: <SKILL.md text> }

RUNTIME (existing path, unchanged)
--------------------------------------------------------------------
usage.ts fetchAgentSkills(agentId, tenantId)
  -> flat SELECT on agent_skills only (name, system_prompt, install_id, version)
  -> string-concat "## Skill: X\n\n<body>" into requestContext
  -> platformAgent.ts `instructions` fn folds it into the system prompt,
     every turn, exactly as today

RUNTIME (new, additive — only runs when teach mode is on, per Open Question 2)
--------------------------------------------------------------------
platformAgent.ts new `skills:` field (dynamic resolver)
  if teach mode is off for this scope: return [] — zero overhead, identical
  to today's behavior (no catalog injection, no skill_read tool)
  else, for each active agent_skills row with a non-null install_id:
    - NEW join: skill_installs (by install_id, tenant_id) -> skill_versions
      (by skill_id + the resolved_version column per Open Question 1)
    - fetch remaining files (excluding SKILL.md) through the reference
      provider (see below), not inline S3 calls
    - slugify(name) for createSkill's name constraint
    - createSkill({ name: slugify(name), description: <manifest description>,
                     instructions: <manifest.body>, references: {...} })
  -> Mastra's SkillsProcessor injects <available_skills> catalog every turn
     this agent/session has teach mode on + registers skill/skill_search/skill_read
  -> agent calls skill_read(...) only when it decides the task needs it
```

### Reference provider — a named seam, not inline S3 calls

Looked at how `deepseek-harness` (deepseek-ai's open-source agent harness)
structures analogous capabilities and it's worth copying one thing: every
swappable capability there is a named triad — Service Definition (the
interface), Provider (the implementation), Consumer (the thing that calls
it) — never inlined into the orchestration code that uses it. Their own
example: pointing the `fs`/`subprocess` provider at a remote sandbox moves
Bash, PTY, and LSP with it, with no fork of the calling code, because the
calling code only ever knew the interface.

Apply the same shape here instead of writing S3 calls directly inside the
`skills:` resolver:

- **Interface:** `SkillReferenceProvider` — `list(skillId, version):
  string[]` and `get(skillId, version, filename): Promise<string>`. The
  resolver (Consumer) only ever calls this interface.
- **Provider (v1):** an S3-backed implementation, wrapping whatever client
  setup Open Question 3 resolves, plus the caching behavior from Open
  Question 4.
- Why bother now, for a first implementation: the resolver code, the
  `createSkill()` call shape, and the tests around them stay unchanged if
  the provider is later swapped (a different bucket, a local filesystem
  provider for tests, a future non-S3 backend) or if caching strategy
  changes. Without this seam, a caching change or credential-mechanism
  change (Open Questions 3-4) means editing the resolver itself and
  re-reviewing its security-sensitive join logic for no reason related to
  the actual change being made.

## Testing

- New join: cross-tenant/cross-agent denial tests (this is new surface, per
  the "false mirror" finding above — write these as if from scratch, not as
  a copy of `fetchAgentSkills`'s tests).
- Version-consistency behavior per whichever Open Question 1 option is
  chosen — a test that exercises the chosen behavior explicitly (e.g., for
  option (b): install upgraded without re-attach, references reflect new
  version, body still reflects old — assert this is the *intended* behavior,
  not an accidental one).
- `createSkill()` name normalization: a skill named with spaces/mixed case/
  non-hyphen characters doesn't throw.
- A measured before/after token count for a representative agent+skill set
  with teach mode **on**, attached to this spec's approval record before
  implementation starts.
- Teach mode **off**: assert zero resolver invocation, zero catalog
  injection, zero new tool schemas — same system prompt shape as today.
- `SkillReferenceProvider`: test the S3 implementation against the
  interface directly (list/get), independent of resolver tests — the
  resolver's tests should be able to use a fake provider and never touch S3.

## Rollout

Once the open questions are resolved and this spec is re-reviewed: the Ad
Creative skill (the concrete trigger for this whole design) gets seeded
through the **existing zip-import route** — `POST /skills` with
`source: { type: 'zip', fileKey }` — not a direct DB insert. Package the
SKILL.md body plus `references/platform-specs.md` and
`references/generative-tools.md` into a zip, upload via
`POST /skills/upload-url`, then import normally.
