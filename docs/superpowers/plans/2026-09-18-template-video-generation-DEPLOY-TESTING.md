# Deploy-time testing checklist — template-video-generation

Everything below must be run on the real dev server (GCP VM), not locally — this
worktree has no reachable database, no real `GEMINI_API_KEY`, and no running
orchestrator. Do this after pulling this branch's commits onto the server and
restarting the affected PM2 processes (`inference-gateway`, `agent-orchestrator`
— per CLAUDE.md, `./deploy.sh` does NOT restart these, use `pm2 restart <name>`
by hand for each).

## Required before Task 9+ (Phase 1) code is enabled for real users

**This is the hard gate from `docs/superpowers/plans/2026-09-18-template-video-generation.md`
Task 8, Phase 0.5.** Phase 1 code (Tasks 9-14) may be built and deployed
alongside this check, but the cost/content approval gate does not actually
enforce for video generation until this passes — do not point real users at
template-video-generation before running this.

1. In `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`, find
   `shouldRequireApproval`'s `if (delegationDepth > 0) return false` bypass.
   Temporarily comment it out on the server.
2. Restart `agent-orchestrator` (`pm2 restart agent-orchestrator`).
3. Start a real chat as Olmo. Trigger a template-video-generation flow that
   ends in a delegated `generate_video` call, with a real credit rate
   configured (so `requireApproval` evaluates true — the namespaced
   `google/gemini-omni-1.1-flash` row from Task 6 should already be seeded;
   confirm with the migration script below if not).
4. Observe:
   - Does the approval card actually render in the chat UI?
   - After approving it, does the video actually generate (a real `fileId`
     comes back), or does it silently no-op (per the failure mode documented
     in `project_delegate_network_migration` memory)?
5. Revert the temporary comment-out on the server regardless of outcome.
6. Record the outcome:
   - **If it resumed correctly:** tell Claude so the `delegationDepth > 0`
     bypass can be removed for real (Task 8 Step 4a) and Task 8's pinning
     test updated to assert the new behavior.
   - **If it did not resume correctly:** tell Claude so this can be escalated
     as a separate, real bug fix (`project_delegate_network_migration`'s
     domain) — Phase 1 stays built but the bypass stays in place, meaning
     cost/content gates still don't fire, until that's fixed.

## Also required before first real use (independent of the gate above)

- **Run the Task 6 migration script against the real dev DB** (was written
  and typechecked but never run — no DB access in the worktree):
  ```bash
  cd packages/foundation/database && pnpm exec tsx scripts/2026-09-18-namespace-video-generation-rate.ts
  ```
  Confirms/creates the namespaced `google/gemini-omni-1.1-flash` credit rate
  row Task 7's charge/approval logic looks up. If this hasn't run, every
  video generation on the server after this branch deploys will hit
  `resolveRate` returning null — logged as `[credits] UNBILLED VIDEO
  GENERATION` — meaning free, ungated generation, not a crash. Silent, so
  check the logs for that exact string after first test generation if this
  step gets missed.

- **Run Task 4's image-conditioning spike for real** (was ruled on
  documented Gemini API behavior, not live-tested — see
  `apps/inference-gateway/scratch/image-conditioning-spike.md`): trigger a
  real `animate_frame` or `composite_references` generation with a real
  product photo and confirm `stageImageForOmni`'s Files-API staging actually
  works end-to-end (not just that it's syntactically wired). If the direct
  presigned-URL path turns out to work after all, `stageImageForOmni`
  becomes removable dead code — check the spike file's own follow-up note.

## Manual verification steps named directly in the plan (Tasks 11, 12, 14)

These have no automated test by design (prompt wording / live model
behavior) — run once Phase 1 is deployed:

- **Task 11:** chat as Olmo, say "clone this ad for my brand" with a real
  template slug. Confirm it asks for a product photo and doesn't skip
  straight to generation.
- **Task 12:** trigger a template-clone generation via Olmo→Director,
  INCLUDING once with a tenant that has a custom `agentSystemPrompt`
  override configured. Confirm Director's `generate_video` call uses the
  expected `mode` for a known template profile in both cases (this checks
  the `TEMPLATE_CLONING_SECTION` append-unconditionally fix actually works,
  not just that it compiles).
- **Task 14:** generate a dialogue-bearing clip. Confirm Director calls
  `analyze_audio` afterward and surfaces a mismatch if one exists (can be
  forced by testing against a clip known to mispronounce a coined brand
  name).

## What's already fully verified (no server needed)

Every unit/integration test for Tasks 1-9 (and whichever of 10-14 land by the
time this is read) passes in CI/locally already — this checklist is only the
things that categorically require live infrastructure this worktree doesn't
have. Don't re-verify what the automated suite already covers.
