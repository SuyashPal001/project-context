# Skill content quality bar (shared across creation paths)

Date: 2026-09-08
Status: approved for planning

Split from `2026-09-08-skill-quality-and-references-design.md` — this half
was verified safe and independent by Opus review; the references/S3 half
needed more work and is tracked separately in
`2026-09-08-skill-references-s3-design.md`.

## Problem

Two things, both about description parsed from SKILL.md frontmatter and
about who else, will produce a low quality skill body, verified against
actual code:

1. **Two skill-creation paths, two different content quality bars.** The web
   modal's `/api/skills/generate` route enforces a real content bar via
   `SKILL_SYSTEM_PROMPT` (`generationPrompt.ts`) — tables for numeric specs,
   a concrete good/bad example pair, a named failure-mode list, an output
   template when the skill produces an artifact, and a ban on "ask the user"
   as the skill's actual step content. The in-chat `create_skill` tool path
   is governed by `SKILL_CREATION_CONTRACT` (`platformAgent.ts:~317-322`),
   which only says *who* writes the file (the agent, never the user) — it
   says nothing about content quality. Asking Olmo directly in chat to save
   a skill today produces the same generic, thin output the unpatched
   Generate prompt used to produce.

2. **Description presence is validated; description *quality* is not.**
   `parseSkillManifest` (`worker-handlers/lib/skillManifest.ts:41-43`)
   already throws `SkillManifestError` if `description` is missing or an
   empty string on every import (zip/github/url). That part is **already
   shipped** — this spec does not re-propose it. What's missing is a floor
   on *quality*: a technically-non-empty description like `"a skill"` or
   `"helper"` passes today's check and is agent-facing (used for
   `skill_search`/discoverability once the references design ships), but
   gives an agent nothing to match against.

## Goal

- Both skill-creation paths (web modal Generate, in-chat `create_skill`)
  enforce the same content quality bar, from one shared source of truth.
- An imported skill's frontmatter `description` clears a real quality floor,
  not just a non-empty check, before the import succeeds.

## Non-goals

- Anything about reference files, S3, or Mastra's skill system — see the
  separate references spec.
- Changing `skills.description` (the raw, optional dashboard column) — it
  stays a cosmetic subtitle, unrelated to this quality bar, which only
  concerns the frontmatter `description` inside a skill's `manifest`.
- Retroactively validating already-imported skills. This gates new imports
  going forward only.

## Decisions taken

| Question | Decision |
|---|---|
| Where does the quality bar live | Extracted once into a shared constant, imported by both `SKILL_SYSTEM_PROMPT` (`generationPrompt.ts`) and `SKILL_CREATION_CONTRACT` (`platformAgent.ts`) |
| What "quality floor" means for description | Minimum length (e.g. a real sentence, not one or two words) plus a check for a "when to use this" signal — mirroring what `SKILL_SYSTEM_PROMPT` already asks Generate to produce for the same field |
| Where the import-time check lives | `parseSkillManifest` or immediately after it in `skillImport.ts`, alongside the existing presence check — same error path (`SkillManifestError`), same place a caller already expects import failures to surface |
| Scope | Content-quality only; no schema change, no new table, no new route |

## Architecture

**Shared quality-bar constant.** Extract the bullet list currently living
only in `SKILL_SYSTEM_PROMPT`:

- Tables for numeric specs, not prose.
- At least one concrete good/bad example pair with realistic strings.
- A named failure-mode/common-mistakes list.
- A literal output template/skeleton when the skill produces an artifact.
- Ban on "ask the user" as the skill's actual step content (preconditions
  are fine; a whole skill that's just an intake script is not).

into a new exported constant (e.g. `SKILL_CONTENT_QUALITY_BAR` in
`generationPrompt.ts`, or a new small shared file if that creates an import
cycle between `generationPrompt.ts` and `platformAgent.ts` — check before
picking the location). `SKILL_SYSTEM_PROMPT` references it as it does today
(inline). `SKILL_CREATION_CONTRACT` gets it appended, so an agent writing a
skill directly in chat is held to the same bar. `SKILL_CREATION_CONTRACT`
keeps its own existing rule (agent writes the file, never the user) — that's
about *authorship*, unrelated to content quality, and stays as-is alongside
the shared bar.

**Description quality floor.** Add a check next to the existing presence
check in `skillManifest.ts` (or as a follow-up step in `skillImport.ts`
right after `parseSkillManifest` succeeds): reject (via `SkillManifestError`,
matching the existing failure path so nothing downstream needs to handle a
new error type) a description that's present but clearly too thin — a
reasonable minimum length is the cheapest, least-ambiguous check to start
with (e.g. under ~20 characters is almost never a real "when to use this"
sentence); a stronger content check (e.g. "does it describe a *when*, not
just a *what*") is a nice-to-have but adds LLM-judgment complexity to a
worker path that's currently pure string parsing — start with length, revisit
if thin-but-long descriptions turn out to be a real problem in practice.

## Testing

- `generationPrompt.ts`: existing test file gets an assertion that
  `SKILL_SYSTEM_PROMPT` contains the shared constant's content (not just
  hardcoded duplicate strings — a drift guard).
- `platformAgent.ts` / wherever `SKILL_CREATION_CONTRACT` is defined: new
  test asserting it also contains the shared constant.
- `skillManifest.ts`: new test cases — description exactly at the length
  floor (passes), one character under (rejects with a clear message,
  distinguishable from the existing missing/empty error), and the existing
  missing/empty cases still pass (regression check on the check that's
  already shipped).
