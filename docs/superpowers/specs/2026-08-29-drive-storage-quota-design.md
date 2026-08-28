# Drive Storage Quota — Design

**Date:** 2026-08-29
**Status:** Approved, not implemented

## Problem

Drive accepts any file of any size, in any quantity, from any tenant. There is no
size cap, no per-tenant quota, and no content-type restriction. Storage costs
money, and nothing currently bounds it.

A `storage_gb` entitlement already exists in seed data — free 1GB, starter 10,
business 100, enterprise 1000 — declared as a metered feature with a `metricKey`.
No code reads it. There is no registered usage counter for it, and
`apps/api/src/routes/files.ts` performs no entitlement check on upload. The cap
exists on paper and does nothing.

Two further leaks make a naive quota ineffective:

1. **Deletion does not delete.** `storageService.deleteFile` sets
   `status:'deleted'` and `deletedAt` and returns. The S3 object is never
   removed. A quota counting `status='uploaded'` therefore frees on delete while
   the bill does not: a tenant can upload to the limit, delete, and repeat
   indefinitely.
2. **Abandoned uploads are invisible.** Presign inserts a `pending` row with
   `size` null; the client then PUTs to S3 and calls confirm. If confirm never
   fires, the bytes sit in S3 with no recorded size, outside any sum over
   `status='uploaded'`, permanently.

## Goals

- Bound worst-case storage spend per tenant, particularly on free accounts.
- Make stored bytes and billed bytes agree, so the quota measures something real.
- Stay invisible to legitimate users. Storage limits are not advertised in
  pricing and no meter is shown under normal use.

## Non-goals

- Storage is not a monetization lever. Limits are an abuse ceiling, set generously
  enough that ordinary use never approaches them.
- No restriction on file type. Video and audio remain uploadable.
- No storage-class tiering or lifecycle cost optimization. Out of scope.

## Decisions

| Decision | Value | Rationale |
|---|---|---|
| Per-file cap | 500 MB | Fits phone video and long audio, so real users never hit it. |
| Free tenant quota | 20 GB | ~$0.50/month of S3 at worst. Generous enough to be invisible. |
| Starter quota | 200 GB | Effectively theoretical for the plan's usage. |
| Business quota | 1 TB | As above. |
| Enterprise | Unlimited | Resolves `unlimited`; both gates skipped. |
| Enforcement point | Presign | Confirm-time is after the bytes have already landed in S3. |
| Size binding | Signed `ContentLength` | S3 rejects any body that is not exactly the declared size. |
| Meter visibility | ≥80% only | Warns heavy users before a block; invisible otherwise. |

### Seed changes

`packages/foundation/database/seeds/plan-entitlements.ts` currently carries the
values in the left column. Every one of them changes:

| Plan | Seeded today | New |
|---|---|---|
| free | 1 GB | 20 GB |
| starter | 10 GB | 200 GB |
| business | 100 GB | 1000 GB |
| enterprise | 1000 GB | `unlimited: true` |

Enterprise moving from a 1000GB limit to `unlimited` is the only change that
alters an entitlement's shape rather than its number, so it is the one to verify
resolves correctly — the `unlimited` path is what both gates check first.

Seeds only apply to newly seeded plans. Existing rows in `plan_entitlements`
need a migration or a re-seed to pick these up; shipping the enforcement without
that would enforce the old 1GB free limit, which is far tighter than intended and
would block real tenants.

### Unit convention

Entitlement limits are stored in gigabytes; file sizes are in bytes. One GB is
defined as 1024³ bytes, in a single exported constant, so the meter and the
enforcement path cannot disagree about what a gigabyte is.

## Approach

Rejected alternatives, briefly:

- **Presigned POST with `content-length-range`** enforces a true maximum at the
  S3 policy level without a declared size, but replaces the PUT flow with a
  multipart form POST at every upload call site — including the chat upload retry
  logic. Materially more churn for a small practical gain over the chosen
  approach.
- **Confirm-time checking** requires no storage-package change, but the bytes are
  already in S3 when it runs. An abuser simply never calls confirm. Advisory
  only.

The chosen approach checks at presign and binds the size into the signature.

### Metering

Register a `storage_gb` usage counter through the existing
`registerUsageCounter` registry:

```
SUM(size) FROM files WHERE tenant_id = $1 AND status = 'uploaded'
```

`files.size` is `integer`, capping a single row near 2.1GB, which the 500MB
per-file limit keeps well clear of. The sum must be cast to bigint; Drizzle
returns it as a string, so it is parsed once at the boundary rather than
trusted as a number.

This is the first counter registered by foundation code. `agents` (the only
existing counter) is registered by the agent platform, so the registration point
for a foundation-owned counter needs to be established — the API's startup path,
alongside the other foundation wiring in `apps/api/src/app.ts`.

### Enforcement at presign

`POST /api/v1/files/upload` gains a required `size` field. Two gates run before
any row is inserted or any URL is signed:

1. `size > MAX_FILE_BYTES` → reject `file_too_large`.
2. `used + size > limitBytes` → reject `storage_quota_exceeded`.

Both are skipped when the resolved entitlement is `unlimited`.

The existing `checkUsage` helper in `packages/foundation/entitlements/src/check.ts`
answers whether *any* quota remains (`used < limit`). It cannot answer whether a
specific file fits, so this path performs headroom arithmetic against the
resolved metered entitlement directly rather than calling that helper. The helper
is left unchanged; other callers depend on its current semantics.

The presigned PUT is then signed with `ContentLength` set to the declared size.
The signature covers the `content-length` header, so S3 rejects a body of any
other length. A client that under-declares its size to pass the gate cannot then
upload more than it declared.

### Deletion

`deleteFile` continues to soft-delete the row — the record is wanted for audit
and for the ingestion lineage that references it. It additionally enqueues a
`storage.purge` job carrying the tenant id and S3 key.

A new foundation worker handler registered via `registerHandler` in
`apps/worker/src/router.ts` consumes `storage.purge` and deletes the S3 object.
This uses the existing SQS worker, so it needs no new Lambda function, no
`template.yaml` change, and no Terraform change. Storage is foundation
infrastructure, so the handler belongs in the foundation handler set rather than
the agent platform's.

Purge is idempotent: deleting an already-absent S3 key succeeds, so a redelivered
SQS message is harmless.

### Orphan reclamation

On each presign, before the gates run, sweep the requesting tenant's `pending`
rows whose `createdAt` is older than the one-hour presign expiry. Mark them
`expired` and enqueue `storage.purge` for each.

This is deliberately opportunistic rather than scheduled: the work is
tenant-scoped and bounded by how many uploads that one tenant abandoned in the
last hour, so it adds no new infrastructure and no new EventBridge rule. A tenant
that never uploads again never gets swept, which is acceptable — their orphans
are already counted against nothing and the one-time backfill below catches the
existing population.

`expired` is a new value on `fileStatusEnum` (`pending | uploaded | deleted`),
which requires a migration. It is kept distinct from `deleted` so the two
populations stay separable: `deleted` means a user removed a real file, `expired`
means an upload never completed.

### Usage surface

`GET /api/v1/files/usage` returns:

```json
{ "usedBytes": 0, "limitBytes": 0, "percent": 0, "unlimited": false }
```

Drive renders a usage meter only when `percent >= 80` and `unlimited` is false.
Below that threshold nothing is shown, and nothing about storage appears anywhere
else in the product.

### Errors

Rejections return a machine-readable code alongside the message:

- `file_too_large` — includes the cap and the file's size.
- `storage_quota_exceeded` — includes bytes used and the limit.

The client renders these with the concrete numbers. This is the only place in the
product where a storage limit is ever named, which is why the numbers must be in
the payload rather than hardcoded in the UI.

## Call sites

`size` must be required for enforcement to be meaningful, so every caller changes.
Seven exist:

| Location | Notes |
|---|---|
| `apps/web/components/platform/files/UploadFileModal.tsx` | Drive upload; goes through `/api/proxy`. |
| `apps/web/components/platform/chat/useFileUpload.ts` | Chat attachments; has retry logic, covered by tests. |
| `apps/web/components/platform/ImageUpload.tsx` | |
| `apps/web/components/platform/board/CreateTaskDialog.tsx` | |
| `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.ts` | Covered by tests. |
| `apps/web/hooks/useTaskMutations.ts` | |
| `apps/agent-orchestrator/src/persistence.ts` | Agent-generated files; covered by tests. |

The orchestrator is deployed separately from the Lambda and is not restarted by
`./deploy.sh`. Making `size` required is therefore a breaking change across a
deploy boundary: the API must not reject size-less requests until the
orchestrator carrying the new field is running. Sequencing is covered below.

## Deployment sequencing

1. Ship the API accepting `size` as **optional**, enforcing only when present.
2. Deploy web and the orchestrator with `size` populated at all seven call sites.
   Restart the orchestrator by hand (`pm2 restart agent-orchestrator`).
3. Confirm no size-less presign requests remain in logs.
4. Make `size` required in a follow-up deploy.

Skipping step 1 breaks agent file generation for the window between the Lambda
deploy and the orchestrator restart.

## One-time backfill

A manually run script, not an automatic migration:

- Enqueue `storage.purge` for every soft-deleted file whose S3 object still
  exists.
- Enqueue `storage.purge` for every `pending` row older than one hour, and mark
  it `expired`.

Kept manual because it deletes real S3 objects in bulk and its blast radius
should be inspected before it runs. It should report what it intends to delete
and require an explicit confirmation flag before deleting anything.

## Testing

- **Counter:** sums only `uploaded` rows; excludes `pending`, `deleted`, and
  `expired`; scoped to one tenant; returns 0 for a tenant with no files.
- **Gates:** file at exactly the cap passes; one byte over is rejected; a file
  that fits remaining headroom passes; one that exceeds it is rejected; both are
  skipped when `unlimited`.
- **Units:** a limit of 1 GB resolves to 1073741824 bytes, guarding the GB/GiB
  convention.
- **Purge handler:** deletes the key; succeeds when the key is already absent.
- **Reclamation:** sweeps only the requesting tenant's rows, only those past
  expiry, and leaves `uploaded` rows untouched.
- **Call sites:** existing tests at `useFileUpload.test.ts`,
  `saveAvatarAsset.test.ts`, and `generatedFileUpload.test.ts` must assert `size`
  is sent.

## Risks

- **The 500MB cap rejects files that upload successfully today.** No existing
  file on dev approaches it (the largest observed is 12.1MB), but it is a real
  behavior change for any tenant with large media.
- **Purge is irreversible.** A bug in the key derivation deletes the wrong
  object. The handler must take the stored S3 key rather than reconstructing it,
  and the backfill script must be inspected before it runs.
- **Existing over-quota tenants would be blocked immediately** on the first
  deploy that enforces. Tenant storage on dev is far below 20GB, so this is
  theoretical today, but it should be checked against real data before enforcing
  in any environment with real tenants.
