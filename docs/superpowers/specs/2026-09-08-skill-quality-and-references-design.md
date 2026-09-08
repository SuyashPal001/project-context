# Skill quality and reference-file support

Date: 2026-09-08
Status: approved for planning

## Problem

Three separate gaps, discovered while trying to seed a real multi-file "Ad
Creative" skill (a SKILL.md body plus `references/platform-specs.md` and
`references/generative-tools.md`) as an official skill:

1. **Reference files are inert.** The import worker (`skillImport.ts`) already
   uploads every file in a zip/github package to S3
   (`skill-packages/{skillId}/{version}/{fileName}`), including anything under
   `references/`. But `skillVersions.manifest` — the only thing any runtime
   code reads — only ever gets `{ body }`, the main SKILL.md text.  Nothing
   downstream (`usage.ts:fetchAgentSkills`, `platformAgent.ts`'s `instructions`
   function) reads anything else. Reference files sit in S3, fully uploaded,
   permanently unread.

2. **Skill discoverability can be silently broken by a raw user string.**
   `POST /skills` (`skills.ts:275,288`) writes `skills.description` straight
   from an optional, unvalidated user input field — no length floor, no
   quality bar, no relation to what an agent would search on. Separately, the
   *real* agent-facing description (parsed from a skill's own SKILL.md
   frontmatter, inside `manifest`) is quality-enforced by `SKILL_SYSTEM_PROMPT`
   only on the **Generate** path (web modal). An **imported** skill's
   frontmatter description is whatever the source file already says —
   unvalidated, and easy to ship a skill an agent will never find useful
   enough to search for.

3. **Two skill-creation paths, two different quality bars.** The web modal's
   `/api/skills/generate` route enforces a real content bar via
   `SKILL_SYSTEM_PROMPT` — tables for numeric specs, a good/bad example pair,
   a named failure-mode list, an output template, and a ban on
   "ask the user" as the skill's actual content. The in-chat `create_skill`
   tool path is governed by a completely different, much thinner instruction
   (`platformAgent.ts`'s `SKILL_CREATION_CONTRACT`), which only says *who*
   writes the file (the agent, never the user) — it says nothing about what
   makes the content good. Asking Olmo directly in chat to save a skill today
   produces the same generic, thin output the unpatched Generate prompt used
   to produce.

## Goal

- A skill's reference files are actually readable by the agent that has it
  attached — on demand, not force-injected, with zero regression to today's
  guaranteed-every-turn behavior for the main skill body.
- Whatever description ends up agent-facing (used for discovery) is always
  quality-checked, never a raw unvalidated user string, regardless of which
  creation path produced the skill.
- Both skill-creation paths (web modal Generate, in-chat `create_skill`)
  enforce the same content quality bar, from one shared source of truth.

## Non-goals

- Letting a user attach reference files at *creation* time through the
  dashboard modal or the in-chat `create_skill` tool. This design is
  **runtime-read-only**: it makes references work for any skill whose
  `manifest`/S3 package already has them (i.e., zip/github imports), not for
  hand-authored single-file skills. Authoring-side multi-file support is a
  separate, larger follow-up.
- Migrating the main skill *body* off the force-inject path. It keeps working
  exactly as it does today — this is additive, not a replacement.
- A sub-agent-per-skill execution model. Considered and rejected for this
  case: `skill_read` already isolates a reference's context cost to the turn
  it's read, without the latency/cost of a second model round-trip. Revisit
  only if a specific skill's own execution (not just its reference lookup)
  turns out to need multi-step isolation.
- Retroactively fixing description quality on already-imported skills. This
  design only gates *new* imports going forward.

## Decisions taken

| Question | Decision |
|---|---|
| Where do references live | S3, at the existing `skill-packages/{id}/{version}/` prefix — no new storage, no jsonb duplicate |
| How does the agent read them | Mastra's native `createSkill({ instructions, references })` via a dynamic `skills:` resolver on `platformAgent`, giving the agent `skill_read`/`skill_search` for free |
| Bespoke `read_skill_reference` tool (earlier draft) | Rejected — duplicates `skill_read` with a security surface we'd have to hand-roll (name-collision across tenants, version pinning) for no benefit over the library |
| Scope of this pass | Runtime-read-only; authoring-side changes deferred (see Non-goals) |
| Agent-facing description source | Always `manifest`'s parsed frontmatter description — never `skills.description` (the raw dashboard column) |
| Import-time description validation | New: reject (or flag) an import whose SKILL.md frontmatter description is missing or fails the same bar `SKILL_SYSTEM_PROMPT` already enforces on Generate |
| Quality bar for skill content | Extracted once, referenced by both `SKILL_SYSTEM_PROMPT` (Generate) and `SKILL_CREATION_CONTRACT` (in-chat `create_skill`) — one source of truth, not two prompts drifting apart |

## Architecture

### 1. Reference-file runtime support

```
CREATION / STORAGE (already built, unchanged)
--------------------------------------------------------------------
worker: skillImport.ts
  - uploads EVERY package file to S3:
      skill-packages/{skillId}/{version}/SKILL.md
      skill-packages/{skillId}/{version}/references/platform-specs.md
      skill-packages/{skillId}/{version}/references/generative-tools.md
  - manifest = { ...frontmatter, body: <SKILL.md text> }   (references NOT
    copied into manifest — S3 stays the one source of truth for file bytes)

RUNTIME (existing path, unchanged)
--------------------------------------------------------------------
usage.ts fetchAgentSkills(agentId, tenantId)
  -> agentSkills.system_prompt (= manifest.body, copied at attach time)
  -> string-concat "## Skill: X\n\n<body>" into requestContext
  -> platformAgent.ts `instructions` fn folds it into the system prompt,
     every turn, exactly as today

RUNTIME (new, additive)
--------------------------------------------------------------------
platformAgent.ts new `skills:` field (dynamic resolver, same
  { requestContext } shape `instructions`/`tools` already use)
  for each active agent_skills row (same tenant/agent-scoped join
  fetchAgentSkills already does):
    - resolve skillId + installedVersion -> skillVersions.s3Prefix
    - ListObjectsV2 under that prefix, excluding SKILL.md itself
    - GetObject each remaining file -> { filename: content }
    - createSkill({ name, description: <manifest frontmatter description>,
                     instructions: <manifest.body>, references: {...} })
  -> Mastra auto-registers skill / skill_search / skill_read
  -> agent calls skill_read("ad-creative", "platform-specs.md") only when
     it decides the task needs it — cost lands on that turn only
```

**Why this doesn't duplicate the body in context twice:** the resolver's
`createSkill({instructions: manifest.body})` exists so `skill`/`skill_search`
can describe the skill accurately and so `skill_read` can return the body
too if asked directly — but the *forced* copy of the body still comes only
from the existing `instructions` string path. The two are independent; a
model that already has the body force-injected has no reason to call
`skill_read` for the same content, and nothing charges it twice for doing so
since `skill_read` output only lands in context if actually called.

**Security.** The resolver re-derives its own tenant/agent-scoped join —
`agent_skills` → `skill_installs` (by `install_id`, `tenant_id`) →
`skill_versions` (by `skill_id`, the install's *pinned* `installed_version`,
not `skills.latest_version`) — mirroring exactly what `fetchAgentSkills`
already does, including its version-collision dedupe (highest version per
name). Hand-authored skills (`install_id IS NULL`) have no S3 package and
correctly resolve to zero references, not an error.

**Caps.** The new discoverability surface (name + description, always
visible) is cheap and not charged against `MAX_COMPOSED_SKILL_CHARS` — that
cap stays scoped to the force-injected body path, per the Problem section's
clarification that force-inject and on-demand-read are different cost
models entirely. No change needed to `MAX_ATTACHED_SKILLS` /
`MAX_COMPOSED_SKILL_CHARS` in `usage.ts` or their mirror in
`agent-skills.ts`.

### 2. Description sourcing

- The resolver above reads `description` exclusively from
  `manifest`'s parsed frontmatter (the value `parseSkillManifest` already
  extracts from the SKILL.md the worker imported) — never from
  `skills.description`, the raw optional dashboard field. That column stays
  what it always was: a cosmetic subtitle on the dashboard card, not
  agent-facing.
- `skillImport.ts`'s import path gains a validation step, run against the
  same bar as item 3 below: if the parsed frontmatter's `description` is
  missing, or fails the shared quality check (too short, no "when to use"
  signal), the import is rejected with a clear reason rather than silently
  producing a skill an agent will never discover. This mirrors how
  `SKILL_SYSTEM_PROMPT` already treats description on the Generate path —
  extending the same standard to imports, which currently bypass it
  entirely.

### 3. One shared quality bar for skill content

- Extract the content-quality rules currently living only in
  `SKILL_SYSTEM_PROMPT` (`apps/agent-orchestrator/src/skills/generationPrompt.ts`)
  — tables for numeric specs, a concrete good/bad example pair, a named
  failure-mode list, a literal output template when the skill produces an
  artifact, and the ban on "ask the user" as the skill's actual step content
  — into one shared constant.
- `SKILL_SYSTEM_PROMPT` (Generate) and `SKILL_CREATION_CONTRACT`
  (`platformAgent.ts:319-320`, in-chat `create_skill`) both reference it, so
  a skill Olmo writes unprompted in conversation is held to the same bar as
  one generated through the modal. `SKILL_CREATION_CONTRACT` keeps its
  existing, separate rule (agent writes the file, never the user) — that's
  about *authorship*, not content quality, and stays as-is alongside the
  shared bar.

## Testing

- `usage.ts` / resolver: existing test file extended for the join producing
  correct references per skill, correct empty-references result for
  hand-authored (`install_id IS NULL`) rows, and correct version-pinning
  (pinned `installed_version`, not `latest_version`).
- New tests: cross-tenant and cross-agent denial on the resolver's join
  (mirroring `fetchAgentSkills`'s existing security tests).
- `skillImport.ts`: new test asserting an import with a missing/weak
  frontmatter description is rejected with a clear reason, not silently
  imported.
- `generationPrompt.ts` / `SKILL_CREATION_CONTRACT`: test that both surfaces
  reference the same extracted quality-bar constant (a drift guard — if one
  changes without the other, the test catches it).

## Rollout

The Ad Creative skill (the concrete trigger for this design) gets seeded
through the **existing zip-import route** — `POST /skills` with
`source: { type: 'zip', fileKey }` — not a direct DB insert. Package the
SKILL.md body plus `references/platform-specs.md` and
`references/generative-tools.md` into a zip, upload via
`POST /skills/upload-url`, then import normally. This is also the first
real exercise of the new import-time description validation.

## Follow-ups (explicitly deferred, not forgotten)

- Authoring-side multi-file skill creation (dashboard modal, `create_skill`
  chat tool) — so a user/agent can attach references at creation time, not
  only via zip/github import.
- Revisiting `MAX_COMPOSED_SKILL_CHARS` guidance/documentation so it's
  clearly scoped to the force-inject path only, preventing future confusion
  like the one this design started from.
