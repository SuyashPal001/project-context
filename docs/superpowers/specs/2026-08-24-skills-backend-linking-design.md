# Skills backend linking + Test-in-chat — Design

Date: 2026-08-24

## Context

The Skills feature UI (`apps/web/components/platform/skills/SkillCard.tsx`,
`SkillDetailModal.tsx`, `SkillDetailContent.tsx`) has several fields/actions
that are cosmetic — not backed by real data or handlers. This spec covers
fixing those, adding run-count tracking, and adding a "Test in chat" action.

Findings from research (see conversation) that shape this design:

- Only `runs` (both card + modal), `downloads` (card), the "Author" meta
  row, and the "Files" sidebar are unlinked. Everything else (name,
  description, badges, versions, install/uninstall/publish) already calls
  real endpoints.
- The card's "Install" element is a non-interactive `<span>` styled as a
  button — no click handler.
- Attaching a skill to an agent (`AttachSkillPicker.tsx` →
  `POST /:agentId/skills`) currently sends only `skill.description` (or
  name) as `systemPrompt`. The agent never receives the skill's actual
  SKILL.md content. `chatStream.ts` injects whatever string sits in
  `agent_skills.system_prompt` verbatim — so today, attaching a skill barely
  changes agent behavior.
- Skill packages ARE stored per-file in S3 already
  (`skill-packages/{skillId}/{version}/{fileName}`, written by
  `skillImport.ts`), even though only a single concatenated `body` string
  (frontmatter-stripped manifest source) is stored in the DB and exposed via
  `GET /skills/:id`. A file-listing endpoint is therefore cheap — it reads
  an existing S3 prefix, no package-format change needed.
- No usage/run tracking exists anywhere for skills (confirmed via
  audit-log-action and column search). Must be built from scratch.
- There's no genuine "default agent" per tenant. `agents.isDefault` is a
  dead column (never written). The chat page's own "New Chat" flow falls
  back to `activeAgents.find(a => a.isDefault) ?? activeAgents[0]`
  (`useChatPage.ts:57-62`), which in practice resolves to the
  earliest-created active agent for the tenant (typically "Research
  Engineer", seeded first in `onboarding.ts`). "Test in chat" reuses this
  exact fallback rather than inventing new default-agent logic.

## Scope (5 phases, can ship independently in order)

### Phase A — Small UI fixes
- `GET /skills/:id` (and `/skills` list) includes real owner info (name/email
  of the creator) instead of the current stand-in.
- `SkillDetailContent.tsx` "Author" row renders that real value.
- `SkillCard.tsx`'s fake `<span>` becomes a real `<button>` calling
  `installSkill(skillId)` (same call the modal already uses), with
  `e.stopPropagation()` so it doesn't also trigger the card's
  open-modal `onClick`.

### Phase B — Real skill content on attach
- `agent-skills.ts` `POST /:agentId/skills`: server resolves `installId` →
  active `skill_installs` row → its `skill_versions.manifest.body` (same
  lookup `GET /skills/:id` already does) and stores that as
  `agent_skills.system_prompt`. The client stops sending `systemPrompt` —
  it's derived server-side so it can't be spoofed or go stale.
- No change needed downstream (`chatStream.ts`, `platformAgent.ts` already
  inject whatever's in that column).
- This directly enables Phase E to be meaningful.

### Phase C — Run-count and download-count tracking
- New column `skill_installs.run_count` (int, default 0) — tenant-scoped,
  matching what the card displays per-install.
- Increment in `chatStream.ts` at the existing `fetchAgentSkill(agentId)`
  call site (per chat message sent while a skill is attached) — resolve the
  install and increment its counter.
- New column `skills.download_count` (int, default 0) — global across all
  tenants (mirrors how the card already shows global badges like
  Official/Community, not per-tenant state). Incremented in
  `POST /skills/:id/install` (`skills.ts:367`) on every successful install,
  regardless of whether the installing tenant had installed it before.
  "Downloads" means "times installed, counted globally" — there is no
  separate download action in the product, so install is the download
  event.
- `GET /skills` / `GET /skills/:id` add `runCount` (per-tenant, from
  `skill_installs`) and `downloadCount` (global, from `skills`) to the
  response. `SkillCard.tsx` / modal swap both `—` placeholders for the real
  numbers.

### Phase D — Files sidebar
- New endpoint `GET /skills/:id/files` — `ListObjectsV2` on
  `skill-packages/{skillId}/{version}/` for the resolved version, returns
  `[{ fileName, size }]`.
- `SkillDetailContent.tsx` fetches this and renders the real list instead of
  the hardcoded single "Skill.md" row.

### Phase E — Test-in-chat
- New "Test" button in `SkillDetailModal.tsx`, shown when the skill is
  installed (alongside Uninstall/Publish).
- On click:
  1. Resolve the tenant's default agent the same way `useChatPage.ts` does
     (`activeAgents.find(isDefault) ?? activeAgents[0]`).
  2. `POST /conversations` with that `agentId`.
  3. `POST /:agentId/skills` to attach this skill (now carrying real content
     per Phase B).
  4. Navigate to `/{tenant}/dashboard/chat?conversationId=<id>`.
- If the tenant has zero active agents, show the same "No active agents
  available" error the existing New Chat flow uses — no new error UX to
  design.

## Out of scope
- Multi-file *editing/versioning* UI — Phase D is read-only listing.
- Any change to the skill package/import format.
- A dedicated "default agent" concept/flag — reusing existing (imperfect)
  fallback intentionally, to stay consistent with the rest of the app
  rather than fixing an unrelated pre-existing gap.

## Testing
- Phase A/D: component-level — mock API responses, verify render + click
  handlers (install button doesn't bubble to card `onClick`).
- Phase B: integration test on `POST /:agentId/skills` — verify
  `system_prompt` stored matches `skill_versions.manifest.body`, not the
  client-supplied description.
- Phase C: integration test — send a chat message with an attached skill,
  assert `skill_installs.run_count` increments by 1; call
  `POST /skills/:id/install`, assert `skills.download_count` increments by
  1; assert `GET /skills` reflects both.
- Phase E: manual verification in the running app (per CLAUDE.md — start
  dev servers, click through: open a skill detail modal → Test → confirm a
  new chat opens with the skill attached and the agent's behavior reflects
  the skill content).
