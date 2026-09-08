# Skill reference-file support (S3 + Mastra dynamic skills)

Date: 2026-09-08
Status: draft — needs one more review pass before planning (see Open
questions below; this revision fixes the false claims and missing pieces an
Opus review found in the previous combined draft, but the resolver's
version-consistency behavior still needs a decision, not just a description)

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

## Open questions (must be resolved before this goes to planning)

1. **Version consistency.** Pick one, explicitly:
   - (a) Resolver reads references from the *same* version the cached body
     reflects — but `agent_skills` doesn't currently store which version
     `system_prompt` was resolved from (only the non-authoritative `version`
     display field), so this requires either adding that column or deriving
     it some other way.
   - (b) Resolver reads references from the *live* pinned
     `skill_installs.installed_version`, accepting that this can
     occasionally diverge from a stale cached body until the next
     attach/reconcile — a known, pre-existing limitation, explicitly
     documented rather than silently inherited.
   - (c) Something else (e.g., trigger a `system_prompt` refresh whenever
     the resolver detects a version mismatch) — bigger scope, touches the
     attach path too.
2. **Measure the per-turn catalog cost** (`<available_skills>` block +
   3 tool schemas) against a real agent with several skills attached before
   deciding this is acceptable. If it's large, decide whether that's fine
   (discoverability is worth the tokens) or whether the `skills:` resolver
   should be gated to only run when at least one attached skill actually has
   references (skip the whole Mastra skills path for agents with only
   body-only skills, preserving today's zero-overhead behavior for the
   common case).
3. **S3 access from the orchestrator VM.** Confirm what credential
   mechanism is available/intended (instance role vs. explicit key vs.
   Secrets Manager, per this repo's usual pattern) before picking a
   dependency and client setup — this is infra work, not just an npm install.
4. **Caching.** Since a specific `(skillId, version)`'s S3 objects are
   immutable once `status = 'ready'` (a new version gets a new prefix), a
   cache keyed on `(skillId, version)` with no TTL is safe and removes the
   per-turn S3 round-trip after the first read. Confirm this is in scope for
   the first implementation or explicitly deferred with the latency cost
   accepted for v1.

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

RUNTIME (new, additive — pending Open Questions 1-4 above)
--------------------------------------------------------------------
platformAgent.ts new `skills:` field (dynamic resolver)
  for each active agent_skills row with a non-null install_id:
    - NEW join: skill_installs (by install_id, tenant_id) -> skill_versions
      (by skill_id + a version per Open Question 1's decision)
    - list S3 objects under that version's s3Prefix, excluding SKILL.md
    - fetch each remaining file (cached per Open Question 4)
    - slugify(name) for createSkill's name constraint
    - createSkill({ name: slugify(name), description: <manifest description>,
                     instructions: <manifest.body>, references: {...} })
  -> Mastra's SkillsProcessor injects <available_skills> catalog every turn
     (cost per Open Question 2) + registers skill/skill_search/skill_read
  -> agent calls skill_read(...) only when it decides the task needs it
```

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
- A measured before/after token count for a representative agent+skill set,
  attached to this spec's approval record before implementation starts.

## Rollout

Once the open questions are resolved and this spec is re-reviewed: the Ad
Creative skill (the concrete trigger for this whole design) gets seeded
through the **existing zip-import route** — `POST /skills` with
`source: { type: 'zip', fileKey }` — not a direct DB insert. Package the
SKILL.md body plus `references/platform-specs.md` and
`references/generative-tools.md` into a zip, upload via
`POST /skills/upload-url`, then import normally.
