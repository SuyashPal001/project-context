# TVC Live-Test Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the seven defects found in the first live Bubbli TVC run (2026-10-06) in code, not prompt text.

**Architecture:** Each task is a small, self-contained fix in one tool or module, with a test that pins the failure seen live. Where a native Mastra capability exists (trace retention), use it before hand-building.

**Tech Stack:** TypeScript, Mastra `createTool`, zod v3, vitest, Next.js (web), Postgres (Supabase).

**Spec:** this plan carries its own requirements. The user approved this design in chat on 2026-10-06: "do all 7".

## Global Constraints

- Work in worktree `.claude/worktrees/tvc-live-fixes` on branch `tvc-live-fixes`. Never `git stash`, never push, never deploy, never run destructive SQL against a real database.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tool input schemas must never contain numeric enums (`z.literal(number)` unions). Gemini rejects them, and one bad tool breaks every agent call.
- Fixes live in tool or runtime code. Skill-prompt changes are additive only (append lines, never reword).
- Existing callers are unchanged unless the task says otherwise. Talking-head, UGC and animated-ad flows keep their behaviour.
- New refusals are plain words that Director or Olmo can act on.
- Run the touched package's tests and `pnpm exec tsc --noEmit -p .` before committing.

## Review Focus

1. **Greetings stay cheap:** "hi", "thanks" and "ok" still get thinking budget 0 and hide the delegates. Pinned in Task 6.
2. **Real approvals and typos reach the Director:** "aoorived", "yes approved" and short unknown words do not hide the delegates. Pinned in Task 6.
3. **The plan cannot be satisfied by editing cut times:** cut times come from the reference file itself. Pinned in Task 4.
4. **The product photo is the user's product image:** never a video, never the reference file, never a frame pulled from the reference. Pinned in Tasks 1 and 2.
5. **Trace cleanup never touches non-trace tables,** and keeps at least the last 3 days. Pinned in Task 7.

---

### Task 1: plan_tvc refuses a product photo that is not an image or is the reference
**Files:** `apps/agent-orchestrator/src/mastra/tools/planTvc.ts`, `tvcPlan.ts` (if a schema field is needed), tests.
**Live failure:** `brief.productPhotoFileId` was the reference video's fileId (`c04a1ced…`). Every still then failed with `GENERATION_FAILED`.
- [ ] On `check`, resolve the product photo file's mime type the way other tools resolve file metadata (reuse an existing helper, e.g. `fetchPresignedUrl` / file lookup; find it with grep). Refuse with `PRODUCT_PHOTO_NOT_IMAGE: the product photo must be a photo of the product (jpg/png/webp), not a video; ask the user to upload one` when it is not `image/*`.
- [ ] If the plan names the reference video (see Task 4's `brief.reference.videoFileId`) and it equals `productPhotoFileId`, refuse with the same reason.
- [ ] Make the mime lookup an injectable dependency (`PlanTvcDeps`), so tests need no network. If the lookup itself fails, refuse with `PRODUCT_PHOTO_UNCHECKED: could not read the product photo; try again`. Never pass silently.
- [ ] Tests: a video mime is refused; reference id == product id is refused; an image passes; a lookup failure is refused.

### Task 2: the product photo can never be a frame pulled from the reference
**Files:** `extractFrame.ts` and/or `planTvc.ts`, tests.
**Live failure:** with no product photo, Director called `extract_frame` on the reference video ("Bubbli Product Photo Frame") and used Coca-Cola's bottle as the product.
- [ ] Find how files record their origin. Check the files table and the `uploadGeneratedFile` / `uploadFileWithKey` metadata; generated files may live under a `generated/` key or carry a source field. Choose the most reliable signal and say which in the report.
- [ ] `plan_tvc check` refuses a `productPhotoFileId` that was produced by `extract_frame` (or, if origin is not recorded, by any tool from the reference video), with `PRODUCT_PHOTO_FROM_REFERENCE: that image was taken from the reference ad, not the user's product; ask the user for a product photo`.
- [ ] If origin is not recorded anywhere, add the smallest durable marker: e.g. `extract_frame` titles/keys its output so it can be recognised, or records the source video id in existing file metadata. Do not add a DB migration unless there is no other way. If one is needed, stop and report BLOCKED with the reason.
- [ ] Append one line to `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`: `If the brief has no product photo, never take one from the reference video or any other file; return to Olmo so it asks the user to upload a product photo.` Add an expect for it in `officialSkillsSeed.test.ts`.
- [ ] Tests for the refusal.

### Task 3: failed image tiles show as failed, not "100%"
**Files:** web chat components that render the generation tiles (find them: grep `Generating image`, `generate_images`, the progress percentage in `apps/web/components/platform/chat/`). Their tests.
**Live failure:** a `generate_images` batch returned `{"failed":4,"results":[{"index":0,"refused":true,"refusalReason":"GENERATION_FAILED"},…]}` and the preview showed four empty tiles at "100%".
- [ ] When a batch item's result is `refused`/failed, its tile shows a "Failed" state (plain text, the reason in a tooltip or small line), and no percentage. Match the existing light/dark class pairs (the user checks both themes). No boxed containers.
- [ ] Single `generate_image` refusals get the same treatment if they use the same tile.
- [ ] Tests (component test with a refused result). Run `pnpm exec tsc --noEmit -p .` in apps/web. There is a known pre-existing tsc error in `MessageItemTraceOrder.test.tsx`; do not fix it, but do not add new errors.

### Task 4: reference cut times come from the reference file, not from Director
**Files:** `tvcPlan.ts`, `planTvc.ts`, `detectCuts.ts`, tests.
**Live failure:** `detect_cuts` returned 13 cuts. The plan check refused a plan with fewer shots, and Director then rewrote `brief.reference.cutTimes` (13 became 7, and 13 became 11 in a second run) until it passed.
- [ ] Add `brief.reference.videoFileId?: string`.
- [ ] On `plan_tvc check`, when `videoFileId` is set, compute the cut times from the file itself, reusing `detectCuts`' core logic: export a function from detectCuts.ts, e.g. `detectCutTimes(fileId, idToken)`, which both the tool and plan_tvc call. Overwrite `brief.reference.cutTimes` with the result before validation. Cache per fileId within the process.
- [ ] When `cutTimes` is given without `videoFileId`, refuse with `REFERENCE_VIDEO_MISSING: pass brief.reference.videoFileId; cut times are read from the reference file`.
- [ ] When detection fails, refuse with `REFERENCE_CUTS_UNAVAILABLE` (plain words). Never fall back to Director's numbers.
- [ ] The detection is an injectable dep for tests.
- [ ] Append one line to `tvc-ad/director.md`: `Set brief.reference.videoFileId to the reference video; plan_tvc reads its cut times itself, so plan shots to match them rather than editing cutTimes.` Add a seed-test expect.
- [ ] Tests: edited cutTimes are overwritten by the file's real cuts, so the 13-vs-7 case still fails; cutTimes without videoFileId is refused; detection failure is refused.

### Task 5: casting tolerates an unknown category
**Files:** the tool behind `roll_tvc_variations` (find it: grep `roll_tvc_variations` in directorAgent.ts and follow the import; it may live in `rollAvatarVariations.ts`), tests.
**Live failure:** `category: "beverage"` failed the enum (`'beauty' | 'jewellery' | 'fashion' | 'home' | 'food' | 'professional' | 'premium'`). Director retried and it worked.
- [ ] Accept any string for `category`, then map it to the nearest valid category in code with a small synonym table: beverage/drink/snack/soda → food; skincare/cosmetics/makeup → beauty; apparel/clothing → fashion; furniture/decor → home; luxury → premium; business/tech/finance → professional; fallback → the existing default. Keep the enum's values as the description text, so the model still sees them.
- [ ] Tests: "beverage" maps to food; valid values pass unchanged.

### Task 6: short unknown replies keep the Director reachable
**Files:** `apps/agent-orchestrator/src/mastra/thinking.ts` and its test.
**Live failure:** the user's approval reply "aoorived" (3 edits from "approved") was under 15 characters, so it got thinking budget 0. `buildOlmoDelegates` then returned `{}`, Olmo's `agent-director` call became an orphan client tool, and Olmo invented "the video generation service encountered an issue".
- [ ] Change the fast path `if (lower.length < 15 || CONVERSATIONAL.has(lower)) return 0` so that only known conversational messages get 0: the `CONVERSATIONAL` set (greetings, thanks, acks), plus pure emoji or punctuation if that is already the intent. A short message that is neither conversational nor an approval gets the default 1024.
- [ ] Keep every existing approval and typo behaviour.
- [ ] Read the comments around `olmoDelegates.ts` and the 2026-09 "hi → agent-pm" history. Make sure "hi", "hello", "thanks", "thank you", "ok", "cool", "bye" still return 0, and add any common greeting that is missing from CONVERSATIONAL.
- [ ] Tests: "aoorived" → 1024; "yes approved" → 1024; "hi"/"thanks" → 0; an existing test suite stays green.

### Task 7: trace retention keeps the database from filling up
**Files:** to be decided after checking Mastra natively.
**Live failure:** `mastra.mastra_span_events` daily partitions reached about 1 GB (100–280 MB a day). Supabase switched the database to read-only, and every write (login user upsert) failed.
- [ ] FIRST check the installed Mastra docs and packages for native trace or observability retention: `node_modules/@mastra/core/dist/docs/references/*observability*`, `*storage*`, `*tracing*`, and `@mastra/pg` for retention, TTL, `dropOldPartitions` or similar config. Use it if it exists, and say what you found.
- [ ] If there is none: add a small daily job in the orchestrator (follow any existing interval or cron pattern in apps/agent-orchestrator; grep `setInterval`, `cron`). It drops `mastra.mastra_span_events_pYYYYMMDD` partitions older than 3 days.
  - The partition list is read from `pg_inherits` for the parent `mastra.mastra_span_events` only.
  - The name must match `^mastra_span_events_p\d{8}$`, and the date is parsed from the name.
  - It never drops today's, future, or the last 3 days' partitions.
  - It logs what it dropped. Any error is logged, never thrown.
  - Partition names are validated before being interpolated into SQL.
- [ ] Make it configurable by env `TRACE_RETENTION_DAYS` (default 3; minimum 2).
- [ ] Tests: the pure function that picks partitions to drop, given a list and today's date. Non-matching names are never picked. The last N days and future partitions are never picked.

## Deploy (user, after merge)
- Orchestrator: `./deploy-orch.sh` (also seeds official skills).
- Web: `./deploy.sh`.
