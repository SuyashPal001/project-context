# Async media job polling — design

Date: 2026-09-23
Status: approved in chat, pending written-spec review

## Problem

`generateVideo.ts` and `generateImage.ts` are fully synchronous: `execute()`
blocks on a `fetch` to the inference gateway (up to 270s/90s) before
returning. Nothing in the schema, the gateway contract, or `agent_tasks`
tracks generation as an async job — `jobId` in `generateVideo.ts` today is a
synthetic `${conversationId}:${toolCallId}` string used only as a credits
idempotency key, not a row anywhere.

Skills that need several clips per turn (short-drama-stitch,
animation-character, and future skill 6) serialize N generations one-by-one
inside a single agent turn instead of running them concurrently — that is
the actual driver for this work, confirmed as the primary motivation before
design started (not the gateway timeout ceiling, which is a secondary,
unaddressed concern here).

Confirmed independent of the casting/asset-picker tool layer (item 2 of the
same gap list): casting tools are pure DB reads with no generation or job
concept (see `retrieveTemplate.ts` as the closest existing analog); this
work is entirely new job infrastructure neither creates as a side effect.
Build order between the two is a free choice.

## Scope

Both `generateVideo` and `generateImage` get the async job treatment.
`generateVideo`/`generateImage` are replaced in place — not duplicated as
new `start_*` tools — so every existing caller gets the concurrency benefit
automatically and Director never has to choose between a sync and an async
path for the same generation.

No `save_image_artifact` tool. Both kinds auto-upload to the files table on
job completion, identical to today's synchronous behavior — a
review-before-save flow (generate N candidates, keep 1) has no real caller
today and would be building ahead of one.

## Architecture / data flow

1. `execute()` on `generateVideo`/`generateImage` keeps everything through
   the credit charge unchanged: dialogue gate, identity-anchor gate, source
   image resolution, charge-before-call. This is still the correct point to
   charge — nothing about going async changes *when* the tenant is billed.
2. On successful charge, insert a `media_jobs` row (`status: 'pending'`).
3. Fire a detached async function (not awaited) that does the gateway call,
   upload, and row update. `execute()` returns `{ jobId, status: 'pending' }`
   immediately.
4. Two new read-only tools, `check_media_job` and `wait_for_media_jobs`,
   read `media_jobs` to report status.

No new Lambda, queue, or SQS handler. The orchestrator and the inference
gateway already run on the same GCP VM — this is an in-process async
function, not a new service boundary. That also means job state must be
crash-safe against the orchestrator process itself dying (see the stale-job
sweep below), since there is no separate worker to retry the work.

## `media_jobs` table

New file `products/agent-platform/packages/schema/mediaJobs.ts` (an
agent-platform concept, not foundation — generation jobs belong to skills),
exported from that package's index, migration via `drizzle-kit generate`.

```ts
export const mediaJobs = pgTable('media_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),        // = jobId
  tenantId: uuid('tenant_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  kind: text('kind').notNull(),                        // 'video' | 'image'
  status: text('status').notNull().default('pending'), // 'pending' | 'succeeded' | 'failed'
  chargeKey: text('charge_key').notNull(),
  rateId: uuid('rate_id'),
  rateVersion: integer('rate_version'),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }),
  fileId: uuid('file_id'),
  refusalReason: text('refusal_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
```

Indexed on `(tenantId, conversationId)` and on `status` (for the stale-sweep
query). `id` doubles as `jobId` — no separate synthetic key needed.

## Tool changes: `generateVideo` / `generateImage`

Post-charge body becomes:

```ts
const [job] = await db.insert(mediaJobs).values({
  tenantId, conversationId, kind: 'video', status: 'pending',
  chargeKey, rateId, rateVersion, amountMicro,
}).returning()

runVideoJob(job.id, { tenantId, agentId, conversationId, idToken, chargeKey, rateId, rateVersion,
  gatewayPayload: { model: GATEWAY_MODEL_ID, prompt, task, aspectRatio, durationSeconds, imageUri } })
  .catch(err => console.error(`[media_jobs:${job.id}] unhandled error in background job runner:`, err))

return { jobId: job.id, status: 'pending', model: VIDEO_MODEL, ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}) }
```

`runVideoJob` (new file `videoJobRunner.ts`) is the current post-charge body
of `generateVideo.ts` verbatim — gateway fetch, base64→buffer,
`uploadGeneratedFile`, refund-on-failure — rewritten to update the
`media_jobs` row instead of `return`-ing. Every exit path inside it must
itself resolve (never throw) so the row always lands in a terminal state;
the `.catch` above is a backstop against a bug in that guarantee, not the
primary mechanism. `generateImage.ts` gets the identical treatment
(`runImageJob`).

**Edge case — charge succeeds, row insert fails.** The insert must be
wrapped in the same try/catch as the charge: insert failure triggers an
immediate refund and `{ refused: true, refusalReason: 'JOB_CREATE_FAILED' }`,
matching every other post-charge failure path already in this code.

`requireApproval` is unaffected — it still gates entry into `execute()`
before any of this runs.

## `check_media_job` / `wait_for_media_jobs`

Both filter by `tenantId` in addition to `jobId`, as defense in depth — a
`jobId`/wrong-tenant mismatch and a genuinely missing job both return
`JOB_NOT_FOUND`, so neither tool leaks cross-tenant job existence.

```ts
export const checkMediaJob = createTool({
  id: 'check-media-job',
  inputSchema: z.object({ jobId: z.string().uuid() }),
  outputSchema: z.object({
    jobId: z.string(), status: z.enum(['pending', 'succeeded', 'failed']),
    fileId: z.string().optional(), refusalReason: z.string().optional(),
  }),
  execute: async ({ jobId }, ctx) => {
    const tenantId = ctx?.requestContext?.get('tenantId') as string | undefined ?? ''
    const job = await db.query.mediaJobs.findFirst({
      where: and(eq(mediaJobs.id, jobId), eq(mediaJobs.tenantId, tenantId)),
    })
    if (!job) return { jobId, status: 'failed', refusalReason: 'JOB_NOT_FOUND' }
    return { jobId, status: job.status, fileId: job.fileId ?? undefined, refusalReason: job.refusalReason ?? undefined }
  },
})
```

`wait_for_media_jobs` takes `jobIds: string[]` and an optional
`timeoutSeconds` (default 240, capped at 250 — must stay under the calling
turn's own outer timeout). Polls the same tenant-scoped query on a 2s
interval until every job is terminal, or returns early at the timeout with
`status: 'pending'` for whichever jobs are still running — never throws on
timeout, since a partial result (some clips ready, some still rendering) is
actionable, not a hard failure.

## Stale-job sweep (crash recovery / credit safety)

If the orchestrator restarts or crashes mid-job, a `pending` row would sit
forever with its charge never refunded. A periodic sweep (`setInterval`,
5 min, mirroring `WatchdogFunction`'s cadence for the same class of problem
in a different runtime) started once at orchestrator boot:

```ts
async function sweepStaleMediaJobs() {
  const stale = await db.select().from(mediaJobs)
    .where(and(eq(mediaJobs.status, 'pending'), lt(mediaJobs.updatedAt, fiveMinutesAgo())))
  for (const job of stale) {
    const claimed = await db.update(mediaJobs)
      .set({ status: 'failed', refusalReason: 'STALE_TIMEOUT' })
      .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, 'pending')))
      .returning()
    if (claimed.length > 0) await refundJobCharge(job) // reuses refundVideoCharge/refundImageCharge by kind
  }
}
```

5 minutes is longer than any single gateway call's own timeout (270s/90s),
so it only catches jobs whose process actually died mid-flight, never a
legitimately slow one.

**Race with a genuinely still-running job.** A job can be mid-flight past
the 5-minute mark without the process being dead (e.g. Vertex Veo's own
poll loop can legitimately run long). Both the sweep and the background
runner's completion write must be conditional (CAS) on `status = 'pending'`
so exactly one of them wins:

- The sweep's `UPDATE ... WHERE status='pending'` above only refunds if the
  update actually affected a row — i.e. it really was still pending at that
  instant.
- The background runner's own completion write is
  `UPDATE media_jobs SET status='succeeded', file_id=? WHERE id=? AND status='pending'`.
  If this affects 0 rows, the sweep already claimed the job and refunded it.
  The runner must not leave an orphaned, charge-free file in storage in that
  case: it checks the row's status *before* calling `uploadGeneratedFile`
  and skips the upload entirely if the row is no longer `pending` (or
  deletes the just-uploaded file if the check happens after upload
  completes), and logs the discard.

This makes "succeeded+charged" and "failed+refunded" mutually exclusive and
exactly one of them sticks per job, regardless of which writer gets there
first.

## Testing

- `runVideoJob`/`runImageJob`: mock gateway, assert row transitions and
  refund-on-failure, including the CAS-loses-to-sweep discard path.
- `check_media_job`/`wait_for_media_jobs`: mock DB, assert polling,
  timeout, and tenant-filter behavior (wrong-tenant jobId → `JOB_NOT_FOUND`).
- Sweep: assert stale-but-not-yet-timed-out jobs are left alone, and that a
  job claimed by the runner between the sweep's SELECT and its UPDATE is not
  double-refunded (CAS `WHERE status='pending'` returns 0 rows).
- No live-gateway test changes needed — the gateway contract
  (`/v1/video/generations`, `/v1/images/generations`) is untouched.

## Known limits (not solved here)

- Gateway timeout ceiling (270s/90s) is unchanged — a generation that
  genuinely needs longer than that still fails. Async job polling solves
  concurrency, not the ceiling itself.
- No job listing/history UI. `media_jobs` rows are queryable by future ops
  tooling but nothing surfaces them today beyond `check_media_job` /
  `wait_for_media_jobs`.
