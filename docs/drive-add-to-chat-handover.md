# Drive → chat handover

**Date:** 2026-08-25 · **Commits:** `40e4d1a`..`35bbccb` (17, all pushed to `main`)
**Deploy state: nothing is deployed. None of this has been seen running.**

---

## 1. Deploy first

Two separate deploys — `./deploy.sh` does *not* ship the Lambda.

```bash
./deploy.sh                                   # apps/web  (16 of the 17 commits)
sam deploy --config-file samconfig.dev.toml   # WatchdogFunction only (f5f9071)
```

The watchdog change does nothing until `sam deploy` runs. First evidence it works:
`IIM-Jammu-2026.pdf` on dev has been stuck in `processing` since 20 Aug — it should
flip to `failed` within 5 minutes of the Lambda going out.

If `sam deploy` reports "no changes", suspect stale `dist/` in the foundation packages
(the Makefile bundles `watchdogHandler.ts` from source but pulls
`@serverless-saas/database` through its `dist/`). `files` was verified present in
`packages/foundation/database/dist/schema/storage.js` as of 2026-08-25.

---

## 2. What changed, in one line each

**Drive shows users their files, not our ingestion pipeline.** Everything
pipeline-related moved behind a single `showPipelineDetails` prop (default `false`),
threaded from `FilesList` → `FileListView`, `FileGridView`, `FilesFilter`.

Behind the flag: the Format / Workspace / Classification / Chunks / Status **columns**,
the Workspace and Classification **filters**, the whole **`IngestionSidePanel`** (and
with it the row-click affordance), and the **Ingest / Re-ingest / Parse All** actions.
Default view is `checkbox · Name · Size · Added · Actions`.

**Add to chat.** Pick files (or a folder) in Drive → choose **New session** or an
existing conversation from a searchable picker → land in that chat with the files
staged on the composer. Also available from the composer itself ("From Drive" under
Add context).

**Watchdog Sweep 4** times out stalled file ingests to `failed` after 30 minutes.

---

## 3. Facts already traced — do not re-derive these

Each of these cost real time to establish. They are current as of 2026-08-25.

**Session file scope already exists, and it is one column.**
`folderId` flows: web body → `apps/agent-orchestrator/src/index.ts:74` → injected both
into the system prompt as `<session_context>` (`:115`) and into `requestContext` (`:186`)
→ read by `retrieveDocuments.ts:46` → `retrieveChunks(query, tenantId, limit, threshold,
personFolderId)` → SQL `AND dc.person_folder_id = $x`
(`packages/foundation/ai/src/retrieve.ts:78`).

**Attachments already carry documents *and* media.** `sendMessage` presigns
`image/`, `video/`, `audio/`, `application/pdf` and `.docx`
(`apps/web/app/[tenant]/dashboard/chat/useChatStream.ts:310-321`). This is why the
Add to chat slice needed **zero backend work**, and why ingestion state is irrelevant
on that path — a presigned URL does not care whether we chunked the file.

**Tools authenticate with `INTERNAL_SERVICE_KEY`** and read tenancy from
`requestContext`, never from model input — see `analyzeAudio.ts:29` and
`retrieveDocuments.ts:44-50`. `analyzeAudio` takes a `fileId`, resolves a presigned URL,
and downloads on demand: that is the existing precedent for on-demand file access.

**`GET /api/v1/files` is paginated (default 50) and prefix-scoped**
(`apps/api/src/routes/files.ts:241`). There is **no `GET /files/:id`**. Resolving a set
of ids through the list endpoint silently misses anything outside the current page or
prefix — this is why the Drive→chat handover stages payloads instead of passing ids.

**Creating a conversation drops query params.** `useChatPage.ts:154-165` redirects to
`?id=…`, carrying only `folderId` explicitly. Anything else must survive another way.

**Ingestion is already automatic.** `POST /files/:id/confirm` enqueues `file.ingest`
for pdf/docx/txt/csv (`files.ts:129,177,184`). The manual Ingest buttons were only ever
a *retry* path — which is why hiding them was safe, and why they were hidden rather
than deleted.

**`personFolderId` ≠ Drive folder.** Drive's folders are derived client-side from S3 key
prefixes; `personFolderId` is a separate DB column that most files never carry
(`FilesList.tsx:97` finds one only if some file inside happens to have it). Any design
that assumes "folder ⇒ folderId scope" is wrong for most folders.

**No `success` / `warning` theme tokens exist.** `globals.css` has `primary`
(`#E69DB8`, a rose), `destructive`, `accent`, `muted`, `chart-1..5`, `shimmer-accent`.
Green/amber status colours are literal by necessity. Blue was never a theme colour —
every blue in Drive was a hand-typed Tailwind literal.

---

## 4. Next piece of work: folder scope as a capability

**The idea (agreed, not designed).** Attaching every file in a folder is the wrong
model. Instead the agent should hold a *handle* to the folder and pull the specific file
the user describes — capability over payload.

Why it is better, not just tidier:
- The agent sees a **manifest** (names, types, sizes), not contents, until asked. Real
  exposure reduction.
- Removes the 5-file cap entirely — the current hard limit on folder support.
- Cheaper and sharper: one relevant file beats five mostly-irrelevant ones in context.
- Auditable: "the agent read these two files" is a log line; "the agent had everything"
  is not.

**What it needs:**

| Piece | Status |
|---|---|
| Folder scope on the session | Partly — `folderId` exists but keys off `personFolderId` (see above) |
| `list_files(folder)` — names/types/sizes, no content | Does not exist |
| `read_file(fileId)` — pull one file on demand | Does not exist for documents (`analyzeAudio`/`analyzeVideo` are the pattern to copy) |

**Non-negotiable:** the scope must be enforced **server-side inside the tool**. The model
supplies a `fileId`; the tool must verify it belongs to the caller's tenant *and* falls
within the granted folder before returning a byte. Enforcing this by prompt makes
"the agent can only see this folder" a suggestion, which defeats the entire point.

**Resulting shape:** individual files → attachments (explicit, immediate, multimodal);
folder → scope grant (agent lists, then reads on demand). The `fileCount > 5` disabled
state on folder rows then goes away.

This is architectural — new tools, scope persistence, orchestrator plumbing, a tenancy
check that must be right. It wants a spec before code.

---

## 5. Known gaps

- **Grid view has no Add to chat.** List view only. The two views drifted three times
  during this session; grid is behind again.
- **The admin/dev studio does not exist.** Nothing sets `showPipelineDetails` to `true`.
  It is now load-bearing: it is the only place a failed ingest is visible *or* retryable.
  Until it is built, a failed ingest is invisible to everyone and unrecoverable without
  direct DB access.
- **Watchdog marks failed but never retries.** `files` has no attempt counter, so
  auto-retry would loop a broken file every 5 minutes forever. Deliberate.
- **Conversation search is client-side** over whatever `/api/v1/conversations` returns.
  If that is paginated server-side, older chats are unfindable in the Add to chat picker.
- **Files land in the composer unsent** — staged in, not posted to. Deliberate; you
  usually want to say something about a file you just attached.
- **`classifyDocument` is stale domain logic** (`files.ts:17-26`) — a filename keyword
  match against *pension* terms. Post-pivot it labels everything `Internal` forever.
  Still live for chunk tagging at ingest; only its display use was hidden.

---

## 6. Verification state

Type-check clean (`apps/web`, `agent-api`). 110 web tests pass, 7 of them new
(`apps/web/lib/pendingAttachments.test.ts`). Changed files lint clean — the two
`no-explicit-any` errors in `ChatInput.tsx` are pre-existing
(`window.__addComposeAttachment`).

**No part of this has been observed running.** Layout was iterated from screenshots, and
several judgement calls (column shares, the 30-minute ingest timeout, the 5-file cap)
are reasoned but unvalidated.
