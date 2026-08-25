# Drive folder scope — design

**Date:** 2026-08-26 · **Status:** approved in brainstorming, not implemented

---

## Problem

Attaching every file in a folder to a chat is the wrong model. It caps at whatever
the attachment limit is, ships the whole folder into context to answer a question
about one file, and produces an audit line that says "the agent had everything"
rather than "the agent read these two."

The alternative — the agent holds a handle to the folder and pulls what it needs —
fails if it means reading files at question time. Measured against the tools that
exist: `analyzeVideo` allows 200 MB, `analyzeAudio` 15 MB, both download the whole
file to the VM session cache and run 45 s quick / 150 s deep, blocking inside the
turn. One file per question, up to two and a half minutes, a large multimodal
payload every time. Two files is five minutes. That is not a feature.

So the work has to happen **before** the question, not during it.

## What already exists

- `analyzeAudio` / `analyzeVideo` — presign, download to session cache, call the
  inference gateway. On-demand reading of one file already works.
- `file.ingest` (`products/agent-platform/packages/worker-handlers/handlers/fileIngest.ts`)
  — chunk + embed for pdf/docx/txt/csv, enqueued automatically by
  `POST /files/:id/confirm`.
- `retrieveChunks` (`packages/foundation/ai/src/retrieve.ts`) — hybrid vector +
  text search, with a folder-scoped branch.
- `retrieveDocuments` — reads scope from `requestContext`. **Correction:** it also
  accepts `folderId` as a *tool argument* and prefers it (`folderId ?? contextFolderId`,
  `retrieveDocuments.ts:41,46`), so the model can currently choose its own scope.
  `tenantId` still comes from context, so this is not cross-tenant, but within a
  tenant it is a real hole. An earlier draft of this spec claimed the opposite.
  Fixing it is Task 1 of the plan.
- `files.ingestion_status` plus the watchdog that fails stalled ingests.

## Design

### 1. The index routes; it does not answer

Search returns **which files are relevant**, not prose to answer from. The agent
then reads the top one or two with the tool that fits the type.

This is what makes the cost work. Reading is expensive, so the agent never reads
thirty files — it reads the two the index pointed at. It also lowers what the
index must be good at: ranking, not answering. A per-file summary would do where
full chunking is overkill.

It also makes staleness safe. If the index routes to the right file, the read
takes the truth from the file itself. A stale index degrades ranking, not
correctness — a much better failure mode than answering from stale chunks.

### 2. Membership is resolved, not stored

The grant stores the **prefix** (`new/`). At question time, resolve it: files whose
`key` starts with that prefix, then their chunks via `document_id`.

No folder id, no new column, no back-fill, no dependency on `person_folders`.

`person_folders` is not the right home for this. It has four columns — `id`,
`tenant_id`, `identifier`, timestamps — and means "a folder for a person," a
leftover of the pension-era domain (4 rows; 26 files point at them). Drive folders
are S3 key prefixes. Wiring one to the other adds a sync problem for nothing.

Resolution also gives **live membership**: a file uploaded after the grant is
included automatically, where a stored id would need something to back-fill it.

The weak spot is rename: the grant points at the old prefix. That is one grant row
to update, versus re-tagging every chunk. Cost is a join (files → documents →
chunks) instead of one column compare — not a real loss, since
`document_chunks.person_folder_id` has no index anyway.

### 3. Three tiers, cheapest first

Indexing looks text-only, which seems to disqualify it for a mixed folder — a
folder holds video, audio, images and PDFs side by side. It is only text-only if
nothing makes text first. But making text is not required for a file to be
*findable*, and conflating the two is what makes indexing look expensive.

| Tier | Applies to | Cost | Buys |
|---|---|---|---|
| **1. Metadata** — filename, type, size, dates, prefix, `fileId` | every file | free | the file is listable and routable whenever its name carries signal |
| **2. Quick pass** — 1–2 sentence description | media | ~45 s, once | tells two same-shaped files apart when names do not |
| **3. Deep pass** — full transcript / extracted text | on read, or documents at ingest | 150 s | the actual answer |

Tier 1 is the manifest. The manifest and the index are therefore the same thing,
not two mechanisms — a file is in the index the moment it exists, with no job
having run.

Tier 2 exists because metadata routing fails exactly where it is needed. Real
filenames in this Drive today: `hf_20260817_212810_eeda703e-…` (video),
`hf_20260816_163114_61866578-…` (image), `ElevenLabs_2026-08-18T00_13_38_…`,
`cartesia_audio_2026-08-18T06_47_52…`. Generator prefixes and timestamps. A router
given only metadata cannot answer "which video shows the dashboard" — there is
nothing to match on. One cheap sentence per media file fixes that.

`analyzeAudio` and `analyzeVideo` already implement this split: `QUICK_TIMEOUT_MS`
45 s returns a 1–2 sentence summary, `DEEP_TIMEOUT_MS` 150 s returns a full
transcript. The cheap tier is already built; only tier 3 needs to persist its
output.

Documents keep extracting at ingest as they do today — text extraction is cheap
enough that the tiering does not pay for itself there.

The 150 s is then paid **once per file at most**, and only for files an agent
actually opens — never once per question.

**Constraint — the media branch cannot run in the Lambda worker.** `analyzeAudio`
and `analyzeVideo` live on the GCP VM and call the inference gateway on
`localhost:4001`; per `CLAUDE.md` the VM services are not reachable from Lambda by
design. The media branch runs as a VM-side background worker. The text branch
stays where it is.

### 4. Grant lifetime: sticky, visible, revocable

A grant lasts the whole conversation. Per-message would force a re-grant on every
turn of a normal back-and-forth, which makes the feature unusable.

Sticky reach must therefore be **visible**: the granted folder shows in the chat UI
as a persistent chip with a way to remove it. Invisible durable reach is the thing
to avoid, not durable reach itself.

### 5. Scope enforcement

The model supplies a `fileId`; the tool verifies it belongs to the caller's tenant
**and** falls within the granted prefix before returning a byte. Scope comes from
`requestContext`, never from model input — the `retrieveDocuments` pattern.

Enforcing this by prompt would make "the agent can only see this folder" a
suggestion, which defeats the point of the grant.

## Defects to fix first

1. **`folderId=null` reaches the query.** `FilesList.tsx:157` pushes
   `?folderId=${folderPersonFolderId}` gated only on `!defaultAgentId`. When the
   folder has no `personFolderId` — most of them — the URL carries the literal
   string `null`, which reaches `retrieveChunks` and fails:
   `invalid input syntax for type uuid: "null"` (verified against dev). The query
   throws, so document retrieval is broken for that entire conversation, silently
   from the user's side. Live today.
2. **Schema drift.** `document_chunks.person_folder_id` exists in the database but
   is absent from the Drizzle model (`products/agent-platform/packages/schema/documents.ts:48-62`).
   Queries depend on a column the ORM cannot see; `drizzle-kit push` would drop it.
3. ~~**No index** on `document_chunks.person_folder_id`.~~ **Retracted 2026-08-26 —
   this defect does not exist.** It was inferred from the Drizzle model rather than
   the database. Queried live, `document_chunks` carries five indexes:
   `document_chunks_pkey`, `idx_chunks_tenant`, `idx_chunks_doc`,
   `idx_chunks_sensitivity`, `document_chunks_person_folder_idx` — the last created
   by migration `0056_document_chunks_person_folder`, which is present in
   `_journal.json`. The drift in defect 2 is wider than stated, though:
   `idx_chunks_sensitivity` and `document_chunks_person_folder_idx` are both live and
   both absent from the model, so `drizzle-kit push` would drop indexes as well as a
   column.

   The lesson generalises past this row: **a Drizzle model is not evidence about the
   database.** Several claims in §2 rest on what tables look like in code. Where a
   decision turns on what actually exists, query it.

Defects 2 and 3 concern the legacy `person_folder_id` path, which this design does
not build on but does not remove either — 4 folders and 26 files still use it, and
`retrieveChunks` still has that branch. They are worth fixing because that path
stays live, not because this design needs them.

Defect 1 is independent of this design and should ship on its own.

## Open — decide before building tier 2 or 3

**Where the media pass runs, and what drives it.** §3 states the constraint —
`analyzeAudio` / `analyzeVideo` call the inference gateway on the VM's
`localhost:4001`, and the Lambda worker cannot reach it — but does not design the
thing that satisfies it. Undecided:

- What process runs it. A new PM2 service beside `mcp-server-pc` and
  `inference-gateway` is the obvious shape, but nothing is chosen.
- How work reaches it. The existing path is SQS → Lambda; a VM-side consumer needs
  either its own SQS consumer or an internal endpoint the API calls. The VM already
  authenticates internal calls with `INTERNAL_SERVICE_KEY`, so the second is
  cheaper.
- What happens when it is down. Tier 1 keeps working — files stay listable and
  routable — so the failure is degraded ranking, not an outage. That is the
  argument for not making tier 2 blocking anywhere.
- Retry policy. `files` has no attempt counter, which is why the watchdog marks
  stalls `failed` and never retries. A media pass that retries needs one, or it
  loops a broken file forever.

This is the largest unknown in the build. Everything in §1, §2, §4, §5 and tier 1
of §3 can be built and shipped without resolving it.

## Non-goals

- Replacing individual-file attachments. Files stay explicit, immediate and
  multimodal; folders become scope. Both paths remain.
- Re-indexing on every change. Freshness degrades ranking, not correctness (§1).
- A general permissions model. This is one grant, one conversation, one prefix.

## Testing

- Membership resolution: a file added after the grant is found; a file outside the
  prefix is not.
- Enforcement: a `fileId` from another tenant is refused; a `fileId` inside the
  tenant but outside the granted prefix is refused.
- Routing: search returns ranked files, not prose.
- Tier 1: a file is listable and routable the moment it exists, with no job run.
- Tier 2: two media files with generator-prefix names are distinguishable after
  the quick pass and are not before it.
- Tier 3 failure marks `ingestion_status` and does not strand the file in
  `processing`; a file whose quick pass failed is still findable by metadata.
- Rename: updating a grant's prefix keeps the conversation working.
