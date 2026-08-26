# Drive Folder Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant a chat access to a Drive folder so the agent lists what is in it, routes to the files that matter, and reads only those — instead of attaching every file.

**Architecture:** A grant stores a key prefix on the conversation. Membership is resolved at query time from `files.key`, not stored, so it stays live and needs no back-fill. The index routes (returns ranked files) rather than answers; the agent then reads the top files with the tool that fits the type. Scope is enforced inside each tool, server-side.

**Tech Stack:** Hono on Lambda (`products/agent-platform/packages/api`), Mastra tools on the GCP VM (`apps/agent-orchestrator`), Next.js (`apps/web`), Drizzle + Supabase Postgres, vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-08-26-drive-folder-scope-design.md`

## Global Constraints

- Scope comes from `requestContext`, never from model input. A tool argument that names a folder is a bug (Task 1).
- Every DB query filters by `tenantId`. The grant narrows within a tenant; it never replaces the tenant filter.
- `documents.file_key` holds a **fileId uuid**, not an S3 key. The join is `files.id::text = documents.file_key`. Verified: 20 of 24 documents join; 4 are orphans.
- `conversations.metadata` (jsonb) already exists — the grant needs no migration.
- Package scope is `@serverless-saas/*`. Agent tables come from `@serverless-saas/agent-schema`.
- Product code goes in `products/agent-platform/*` or `apps/*`, never `packages/foundation/*`.
- Deploy targets differ per task: API → `sam deploy`, web → `./deploy.sh`, orchestrator → `pm2 restart`. Product packages must be rebuilt before `sam deploy` or stale `dist/` ships.

---

## File Structure

**Create:**
- `apps/agent-orchestrator/src/mastra/tools/folderScope.ts` — resolve a granted prefix to fileIds; the single place enforcement lives.
- `apps/agent-orchestrator/src/mastra/tools/__tests__/folderScope.test.ts`
- `apps/agent-orchestrator/src/mastra/tools/listFolder.ts` — tier 1 listing tool.
- `apps/agent-orchestrator/src/mastra/tools/findInFolder.ts` — routing tool.
- `apps/agent-orchestrator/src/mastra/tools/readFile.ts` — read one file, dispatch by type.
- `apps/web/components/platform/chat/FolderScopeChip.tsx` — the visible, revocable grant.

**Modify:**
- `apps/agent-orchestrator/src/mastra/tools/retrieveDocuments.ts:23-46` — drop the model-supplied `folderId`.
- `products/agent-platform/packages/schema/documents.ts:48-62` — declare `person_folder_id`.
- `products/agent-platform/packages/api/routes/conversations.ts` — grant set/clear.
- `apps/web/components/platform/files/FilesList.tsx` — folder row grants instead of attaching.
- `apps/agent-orchestrator/src/index.ts` — carry `folderPrefix` into `requestContext`.

---

## Execution status — 2026-08-26

**Tasks 1–8 are complete and on `main`.** Task 9 is the only one left; Tasks 10–11
remain blocked as written. Do not re-run 1–8.

| Task | Commit | State |
|---|---|---|
| 1 scope-override hole | `c90a7f71` | done — needs `pm2 restart agent-orchestrator` |
| 2 chunk table hygiene | `b6fb2374` | done — migration `0068` applied to dev |
| 3 grant on conversation | `828415f3` | done — **deployed** (`sam deploy`) |
| 4 folderScope resolver | `d5d05d11` | done — needs `pm2 restart` |
| 5 grant → requestContext | `7609fbad` | done — needs `pm2 restart` |
| 6 `list_folder` | `e6d3b67f` | done — needs `pm2 restart` |
| 7 `find_in_folder` | `624fef07` (+`8c21df92`) | done — needs `pm2 restart` |
| 8 `read_file` | `25862373` | done — needs `pm2 restart` |
| 9 grant from Drive + chip | — | **not started** |

Until Task 9 lands nothing sets `folderPrefix`, so the tools exist but the feature is
inert.

### Corrections the plan needed, beyond the index retraction below

Each was found by running or querying, not by reading:

- **Task 1's test**: export is `retrieveDocumentsTool`; the tool imports `retrieveChunks`
  from `@serverless-saas/ai`, not the `/retrieve` subpath; and it declares a
  `requestContextSchema`, so a `{ get }` stub is rejected before `execute` runs — build a
  real `RequestContext`.
- **Task 4's SQL**: columns are `name` and `mime_type`, not `filename`/`content_type`;
  the orchestrator imports `db` from `@serverless-saas/database`, not `/client`;
  `db.execute` returns `.rows` on some drivers. **Security**: the prefix reaches a `LIKE`
  pattern and nothing escaped `%`/`_` — a grant of `n%/`, naming no real folder, returned
  all 8 files under `new/` on dev. `escapeLikePrefix` closes it.
- **Task 5's scope**: `index.ts` is the WebSocket path only. The browser uses
  `chat.ts` → `chatStream.ts` (SSE). Doing only `index.ts` ships a feature that works on
  mobile and silently does nothing in the web app. All three sites are wired.
- **Task 7's `ai.embed`**: `embedQuery` is already exported from `@serverless-saas/ai`
  (`index.ts:41`). The join is confirmed: `files.id::text = documents.file_key` gives 21
  of 26 documents; the naive `files.key` join gives 0. The Risks section's fear that every
  document has one chunk is wrong — 183 chunks across 26 documents.
- **Task 8's dispatch**: `analyze_audio` returns `{ success, transcript }` and
  `analyze_video` `{ success, summary }` — **not** `{ text }`. Reading `out.text` returns
  `undefined` content, which the agent reads as "this file is blank" and answers from.
- **Registering a tool breaks `serverTools.test.ts`** by design — it asserts the full
  tool list exhaustively. Update it in the same commit.

## Already done — do not redo

**Spec defect 1 (`folderId=null`) is fixed** in `be788d8`: the emitter omits the
param when there is no id, and both readers validate through
`apps/web/lib/folderScope.ts`. That commit is on `main` but **not deployed** —
it needs `./deploy.sh`, along with `e09ca16`.

---

## Task 1: Close the scope-override hole

`retrieveDocuments` accepts `folderId` as a tool argument and prefers it over the request context (`folderId ?? contextFolderId`), so the model chooses its own scope. `tenantId` still comes from context, so this is not cross-tenant — but within a tenant the model can name any folder.

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/retrieveDocuments.ts:23-46`
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/retrieveDocuments.scope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the invariant every later task relies on — scope is read only from `requestContext.get('folderId')`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'

const retrieveChunks = vi.fn().mockResolvedValue([])
vi.mock('@serverless-saas/ai/retrieve', () => ({ retrieveChunks }))

const { retrieveDocuments } = await import('../retrieveDocuments.js')

const ctx = (values: Record<string, string>) => ({
  requestContext: { get: (k: string) => values[k] },
})

describe('retrieveDocuments scope', () => {
  it('ignores a folderId supplied by the model', async () => {
    retrieveChunks.mockClear()
    await retrieveDocuments.execute(
      { query: 'q', folderId: 'attacker-chosen-folder' } as never,
      ctx({ tenantId: 't1', folderId: 'granted-folder' }) as never,
    )
    const passedScope = retrieveChunks.mock.calls[0]?.[4]
    expect(passedScope).toBe('granted-folder')
  })

  it('uses no scope when the context grants none, even if the model supplies one', async () => {
    retrieveChunks.mockClear()
    await retrieveDocuments.execute(
      { query: 'q', folderId: 'attacker-chosen-folder' } as never,
      ctx({ tenantId: 't1' }) as never,
    )
    expect(retrieveChunks.mock.calls[0]?.[4]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/retrieveDocuments.scope.test.ts`
Expected: FAIL — first test receives `'attacker-chosen-folder'`.

- [ ] **Step 3: Remove the argument**

Delete `folderId` from the tool's `inputSchema`, and change the destructure and call:

```typescript
  execute: async ({ query }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
      ?? (execContext as any)?.context?.tenantId as string | undefined
      ?? ''
    // Scope is granted server-side and is not negotiable by the model: a tool
    // argument naming a folder would let the agent widen its own reach.
    const folderId = (execContext as any)?.requestContext?.get('folderId') as string | undefined
    ...
    chunks = await retrieveChunks(query, tenantId, RETRIEVE_LIMIT, 0, folderId)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/retrieveDocuments.scope.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/retrieveDocuments.ts \
        apps/agent-orchestrator/src/mastra/tools/__tests__/retrieveDocuments.scope.test.ts
git commit -m "fix(agent): stop the model choosing its own document scope"
```

Deploy: `pm2 restart agent-orchestrator` on the VM.

---

## Task 2: Chunk table hygiene — declare the column, index it

> **Corrected during execution.** The original text claimed there was no index on
> `person_folder_id`. There is: `document_chunks_person_folder_idx`, from migration
> `0056`, verified against the live database. The real defect is drift only — the
> column and two indexes (`document_chunks_person_folder_idx`,
> `idx_chunks_sensitivity`) exist live but are absent from the Drizzle model, so
> `drizzle-kit push` would drop them. The migration must therefore be **idempotent**
> (`IF NOT EXISTS`) and must reuse the live index names; a plain `ADD COLUMN` fails
> outright and a new index name creates a duplicate. Steps below are superseded by
> that correction where they conflict.

`document_chunks.person_folder_id` exists in the database but not in the Drizzle model, so `drizzle-kit push` would drop it.

**Files:**
- Modify: `products/agent-platform/packages/schema/documents.ts:48-62`
- Create: migration via `drizzle-kit generate`

**Interfaces:**
- Consumes: nothing.
- Produces: `documentChunks.personFolderId` available to Drizzle queries.

- [ ] **Step 1: Declare the column and its index**

```typescript
export const documentChunks = pgTable('document_chunks', {
  // ...existing columns unchanged...
  // Legacy per-person folder scope. Present in the database since before this
  // model existed; declared here so drizzle-kit push cannot drop it.
  personFolderId: uuid('person_folder_id'),
}, (t) => ({
  tenantIdx: index('idx_chunks_tenant').on(t.tenantId),
  docIdx:    index('idx_chunks_doc').on(t.documentId),
  personFolderIdx: index('idx_chunks_person_folder').on(t.personFolderId),
}));
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`
Expected: a new migration containing `CREATE INDEX ... idx_chunks_person_folder` and **no `DROP COLUMN`**. If a `DROP COLUMN person_folder_id` appears, the column name in Step 1 is wrong — fix it and regenerate.

- [ ] **Step 3: Apply it**

Run: `cd packages/foundation/database && DATABASE_URL="$(grep '^DATABASE_URL=' ../../../apps/api/.env | cut -d= -f2- | sed 's/sslmode=require/sslmode=no-verify/')" pnpm exec drizzle-kit migrate`
Expected: `migrations applied successfully`. The `no-verify` substitution is required — Supabase's pooler presents a self-signed chain and `sslmode=require` fails with `SELF_SIGNED_CERT_IN_CHAIN`.

- [ ] **Step 4: Verify the column survived and the index exists**

Run the same one-off script pattern used for the earlier index check, asserting `idx_chunks_person_folder` is present on `document_chunks` and `person_folder_id` is still a column.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/schema/documents.ts packages/foundation/database/migrations
git commit -m "fix(schema): declare and index document_chunks.person_folder_id"
```

---

## Task 3: Store the grant on the conversation

**Files:**
- Modify: `products/agent-platform/packages/api/routes/conversations.ts`
- Test: `products/agent-platform/packages/api/__tests__/conversations.folderScope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PATCH /conversations/:id` accepts `folderScope: { prefix: string } | null`, persisted at `conversations.metadata.folderScope`. `GET /conversations/:id` returns it. Later tasks read `metadata.folderScope.prefix`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'

describe('folderScope grant', () => {
  it('accepts a prefix and persists it under metadata.folderScope', async () => {
    const res = await app.request('/conversations/conv-1', {
      method: 'PATCH',
      body: JSON.stringify({ folderScope: { prefix: 'new/' } }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.metadata.folderScope).toEqual({ prefix: 'new/' })
  })

  it('clears the grant when given null', async () => {
    const res = await app.request('/conversations/conv-1', {
      method: 'PATCH',
      body: JSON.stringify({ folderScope: null }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.metadata.folderScope).toBeUndefined()
  })

  it('rejects a prefix containing traversal', async () => {
    const res = await app.request('/conversations/conv-1', {
      method: 'PATCH',
      body: JSON.stringify({ folderScope: { prefix: '../other/' } }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
  })
})
```

Build `app` with the same harness as `products/agent-platform/packages/api/__tests__/conversations.persona.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd products/agent-platform/packages/api && npx vitest run __tests__/conversations.folderScope.test.ts`
Expected: FAIL — `folderScope` is stripped by the existing schema.

- [ ] **Step 3: Extend the PATCH schema and merge into metadata**

```typescript
// A prefix is a Drive path segment, not a path expression: no traversal, no
// leading slash, and it must end in "/" so `like prefix || '%'` cannot match a
// sibling folder whose name merely starts with the same letters.
const folderPrefix = z.string().min(1).max(512)
    .refine(p => p.endsWith('/'), 'prefix must end with "/"')
    .refine(p => !p.startsWith('/') && !p.includes('..'), 'prefix must not traverse');

const schema = z.object({
    title: z.string().max(255).optional(),
    status: z.enum(['active', 'archived', 'escalated']).optional(),
    needsHuman: z.boolean().optional(),
    folderScope: z.object({ prefix: folderPrefix }).nullable().optional(),
});
```

Then, before the update, merge rather than overwrite `metadata`:

```typescript
const { folderScope, ...rest } = result.data;
let patch: Record<string, unknown> = { ...rest };
if (folderScope !== undefined) {
    const [row] = await db.select({ metadata: conversations.metadata })
        .from(conversations).where(scope).limit(1);
    const current = (row?.metadata ?? {}) as Record<string, unknown>;
    if (folderScope === null) delete current.folderScope;
    else current.folderScope = folderScope;
    patch.metadata = current;
}
await db.update(conversations).set({ ...patch, updatedAt: new Date() }).where(scope);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd products/agent-platform/packages/api && npx vitest run __tests__/conversations.folderScope.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/conversations.ts \
        products/agent-platform/packages/api/__tests__/conversations.folderScope.test.ts
git commit -m "feat(chat): store a folder grant on the conversation"
```

Deploy: rebuild the product packages, then `sam deploy --config-file samconfig.dev.toml`.

---

## Task 4: Resolve a grant to files — the one place enforcement lives

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/folderScope.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/folderScope.test.ts`

**Interfaces:**
- Consumes: `metadata.folderScope.prefix` from Task 3.
- Produces:
  - `listGrantedFiles(tenantId: string, prefix: string): Promise<GrantedFile[]>` where `GrantedFile = { fileId: string; filename: string; contentType: string; size: number; createdAt: string }`
  - `assertFileInGrant(tenantId: string, prefix: string, fileId: string): Promise<GrantedFile>` — throws `Error('file is outside the granted folder')` otherwise.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'

const rows = vi.fn()
vi.mock('@serverless-saas/database/client', () => ({ db: { execute: rows } }))

const { listGrantedFiles, assertFileInGrant } = await import('../folderScope.js')

describe('folderScope', () => {
  it('lists only files under the granted prefix', async () => {
    rows.mockResolvedValue([{ file_id: 'f1', filename: 'a.pdf', content_type: 'application/pdf', size: 10, created_at: '2026-08-01' }])
    const files = await listGrantedFiles('t1', 'new/')
    expect(files).toEqual([{ fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10, createdAt: '2026-08-01' }])
  })

  it('refuses a fileId that is not under the prefix', async () => {
    rows.mockResolvedValue([])
    await expect(assertFileInGrant('t1', 'new/', 'f-elsewhere'))
      .rejects.toThrow('file is outside the granted folder')
  })

  it('refuses a fileId belonging to another tenant', async () => {
    rows.mockResolvedValue([])
    await expect(assertFileInGrant('t1', 'new/', 'f-other-tenant'))
      .rejects.toThrow('file is outside the granted folder')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/folderScope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { sql } from 'drizzle-orm'
import { db } from '@serverless-saas/database/client'

export interface GrantedFile {
  fileId: string
  filename: string
  contentType: string
  size: number
  createdAt: string
}

// Membership is resolved, never stored: a file uploaded after the grant is
// included automatically, and a rename is one grant row to update rather than a
// re-tag of every chunk. `like prefix || '%'` is safe against sibling folders
// because the API guarantees the prefix ends in "/".
export async function listGrantedFiles(tenantId: string, prefix: string): Promise<GrantedFile[]> {
  const rows = await db.execute(sql`
    SELECT id AS file_id, filename, content_type, size, created_at
    FROM files
    WHERE tenant_id = ${tenantId}
      AND key LIKE ${prefix} || '%'
      AND deleted_at IS NULL
      AND status = 'uploaded'
    ORDER BY created_at DESC
  `)
  return (rows as unknown as Array<Record<string, unknown>>).map(r => ({
    fileId: String(r.file_id),
    filename: String(r.filename),
    contentType: String(r.content_type),
    size: Number(r.size),
    createdAt: String(r.created_at),
  }))
}

export async function assertFileInGrant(
  tenantId: string, prefix: string, fileId: string,
): Promise<GrantedFile> {
  const rows = await db.execute(sql`
    SELECT id AS file_id, filename, content_type, size, created_at
    FROM files
    WHERE tenant_id = ${tenantId}
      AND id = ${fileId}
      AND key LIKE ${prefix} || '%'
      AND deleted_at IS NULL
      AND status = 'uploaded'
    LIMIT 1
  `)
  const row = (rows as unknown as Array<Record<string, unknown>>)[0]
  // One message for "wrong tenant", "outside the folder" and "does not exist":
  // distinguishing them tells the model whether a file it cannot reach exists.
  if (!row) throw new Error('file is outside the granted folder')
  return {
    fileId: String(row.file_id),
    filename: String(row.filename),
    contentType: String(row.content_type),
    size: Number(row.size),
    createdAt: String(row.created_at),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/folderScope.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/folderScope.ts \
        apps/agent-orchestrator/src/mastra/tools/__tests__/folderScope.test.ts
git commit -m "feat(agent): resolve a folder grant to files, with enforcement"
```

---

## Task 5: Carry the grant into requestContext

**Files:**
- Modify: `apps/agent-orchestrator/src/index.ts:74,115,186`
- Test: `apps/agent-orchestrator/src/__tests__/folderPrefixContext.test.ts`

**Interfaces:**
- Consumes: `folderPrefix` on the chat request body.
- Produces: `requestContext.get('folderPrefix')` for Tasks 6–8, and a `<session_context>` line naming the folder so the agent knows it has one.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { buildRequestContext } from '../index.js'

describe('folderPrefix in requestContext', () => {
  it('carries a granted prefix through', () => {
    expect(buildRequestContext({ tenantId: 't1', folderPrefix: 'new/' }).get('folderPrefix')).toBe('new/')
  })

  it('omits it when no grant was made', () => {
    expect(buildRequestContext({ tenantId: 't1' }).get('folderPrefix')).toBeUndefined()
  })
})
```

If `buildRequestContext` is not currently exported, extract it from the inline handler as part of Step 3 — the extraction is what makes this testable.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/__tests__/folderPrefixContext.test.ts`
Expected: FAIL — `buildRequestContext` is not exported.

- [ ] **Step 3: Extract and populate**

Mirror how `folderId` is threaded today (`index.ts:74` reads it from the body, `:115` puts it in the system prompt, `:186` into `requestContext`). Add `folderPrefix` alongside, and add one line to the system prompt:

```typescript
  // Tell the agent it has a folder, but not what is in it — the manifest is a
  // tool call, so a large folder never lands in the prompt.
  folderPrefix ? `<session_context>You have been granted access to the folder "${folderPrefix}". Use list_folder to see what is in it.</session_context>` : ''
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/__tests__/folderPrefixContext.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/index.ts apps/agent-orchestrator/src/__tests__/folderPrefixContext.test.ts
git commit -m "feat(agent): carry the folder grant into request context"
```

---

## Task 6: `list_folder` — tier 1, the manifest

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/listFolder.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/listFolder.test.ts`

**Interfaces:**
- Consumes: `listGrantedFiles` (Task 4), `requestContext.get('folderPrefix')` (Task 5).
- Produces: tool `list_folder`, output `{ files: Array<{ fileId, filename, contentType, size }> }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'

const listGrantedFiles = vi.fn()
vi.mock('../folderScope.js', () => ({ listGrantedFiles, assertFileInGrant: vi.fn() }))
const { listFolder } = await import('../listFolder.js')

const ctx = (v: Record<string, string>) => ({ requestContext: { get: (k: string) => v[k] } })

describe('list_folder', () => {
  it('returns the manifest for the granted folder', async () => {
    listGrantedFiles.mockResolvedValue([
      { fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10, createdAt: 'x' },
    ])
    const out = await listFolder.execute({}, ctx({ tenantId: 't1', folderPrefix: 'new/' }) as never)
    expect(out.files).toEqual([{ fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 }])
  })

  it('says so plainly when no folder is granted, and queries nothing', async () => {
    listGrantedFiles.mockClear()
    const out = await listFolder.execute({}, ctx({ tenantId: 't1' }) as never)
    expect(out.files).toEqual([])
    expect(listGrantedFiles).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/listFolder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { listGrantedFiles } from './folderScope.js'

export const listFolder = createTool({
  id: 'list_folder',
  description: 'List the files in the folder granted to this conversation. Returns names, types and sizes — not contents. Use this before reading anything.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(z.object({
      fileId: z.string(), filename: z.string(), contentType: z.string(), size: z.number(),
    })),
    note: z.string().optional(),
  }),
  execute: async (_input, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
    const prefix = (execContext as any)?.requestContext?.get('folderPrefix') as string | undefined
    if (!tenantId || !prefix) {
      return { files: [], note: 'No folder has been granted to this conversation.' }
    }
    const files = await listGrantedFiles(tenantId, prefix)
    return { files: files.map(({ fileId, filename, contentType, size }) => ({ fileId, filename, contentType, size })) }
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/listFolder.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Register the tool and commit**

Add `listFolder` to the platform agent's tool map alongside `retrieveDocuments`, then:

```bash
git add apps/agent-orchestrator/src/mastra/tools/listFolder.ts \
        apps/agent-orchestrator/src/mastra/tools/__tests__/listFolder.test.ts \
        apps/agent-orchestrator/src/mastra/agents
git commit -m "feat(agent): add list_folder, the granted folder's manifest"
```

---

## Task 7: `find_in_folder` — routing, not answering

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/findInFolder.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/findInFolder.test.ts`

**Interfaces:**
- Consumes: `listGrantedFiles` (Task 4), `requestContext.get('folderPrefix')` (Task 5).
- Produces: tool `find_in_folder`, output `{ matches: Array<{ fileId, filename, contentType, score, why }> }` — ranked files, never prose.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'

const listGrantedFiles = vi.fn()
const execute = vi.fn()
vi.mock('../folderScope.js', () => ({ listGrantedFiles, assertFileInGrant: vi.fn() }))
vi.mock('@serverless-saas/database/client', () => ({ db: { execute } }))
const { findInFolder } = await import('../findInFolder.js')

const ctx = (v: Record<string, string>) => ({ requestContext: { get: (k: string) => v[k] } })

describe('find_in_folder', () => {
  it('returns ranked files rather than prose', async () => {
    listGrantedFiles.mockResolvedValue([
      { fileId: 'f1', filename: 'contract.pdf', contentType: 'application/pdf', size: 1, createdAt: 'x' },
    ])
    execute.mockResolvedValue([{ file_id: 'f1', score: 0.82, snippet: 'penalty clause…' }])
    const out = await findInFolder.execute({ query: 'penalty' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }) as never)
    expect(out.matches[0].fileId).toBe('f1')
    expect(out.matches[0].filename).toBe('contract.pdf')
    expect(out).not.toHaveProperty('answer')
  })

  it('falls back to filename matching when nothing is indexed yet', async () => {
    listGrantedFiles.mockResolvedValue([
      { fileId: 'f2', filename: 'budget-2026.xlsx', contentType: 'application/vnd.ms-excel', size: 1, createdAt: 'x' },
    ])
    execute.mockResolvedValue([])
    const out = await findInFolder.execute({ query: 'budget' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }) as never)
    expect(out.matches.map(m => m.fileId)).toEqual(['f2'])
    expect(out.matches[0].why).toContain('filename')
  })

  it('returns nothing when no folder is granted', async () => {
    const out = await findInFolder.execute({ query: 'x' }, ctx({ tenantId: 't1' }) as never)
    expect(out.matches).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/findInFolder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Rank by indexed chunks where they exist, and fall back to filename matching so tier 1 works before any job has run. The chunk join uses `files.id::text = documents.file_key` — verified as the real linkage.

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@serverless-saas/database/client'
import { listGrantedFiles } from './folderScope.js'

export const findInFolder = createTool({
  id: 'find_in_folder',
  description: 'Find which files in the granted folder are relevant to a question. Returns a ranked list of files — not their contents. Read the top result with read_file.',
  inputSchema: z.object({ query: z.string().min(1) }),
  outputSchema: z.object({
    matches: z.array(z.object({
      fileId: z.string(), filename: z.string(), contentType: z.string(),
      score: z.number(), why: z.string(),
    })),
  }),
  execute: async ({ query }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
    const prefix = (execContext as any)?.requestContext?.get('folderPrefix') as string | undefined
    if (!tenantId || !prefix) return { matches: [] }

    const granted = await listGrantedFiles(tenantId, prefix)
    if (granted.length === 0) return { matches: [] }
    const byId = new Map(granted.map(f => [f.fileId, f]))

    // documents.file_key holds a fileId uuid despite the name — verified against
    // dev, where the naive key join returns 0 rows and this one returns 20 of 24.
    const ids = granted.map(f => f.fileId)
    const rows = await db.execute(sql`
      SELECT d.file_key AS file_id,
             MAX(1 - (c.embedding <=> ai.embed(${query}))) AS score,
             (ARRAY_AGG(LEFT(c.content, 120) ORDER BY c.chunk_index))[1] AS snippet
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.tenant_id = ${tenantId}
        AND d.file_key = ANY(${ids})
      GROUP BY d.file_key
      ORDER BY score DESC
      LIMIT 5
    `) as unknown as Array<Record<string, unknown>>

    const indexed = rows
      .map(r => ({ file: byId.get(String(r.file_id)), score: Number(r.score), snippet: String(r.snippet ?? '') }))
      .filter((m): m is { file: NonNullable<typeof m.file>; score: number; snippet: string } => Boolean(m.file))
      .map(m => ({
        fileId: m.file.fileId, filename: m.file.filename, contentType: m.file.contentType,
        score: m.score, why: `matched indexed content: "${m.snippet}"`,
      }))

    if (indexed.length > 0) return { matches: indexed }

    // Tier 1: nothing indexed yet. Filenames still route when they carry signal.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const byName = granted
      .filter(f => terms.some(t => f.filename.toLowerCase().includes(t)))
      .slice(0, 5)
      .map(f => ({
        fileId: f.fileId, filename: f.filename, contentType: f.contentType,
        score: 0.1, why: 'matched on filename only — this file has not been indexed yet',
      }))
    return { matches: byName }
  },
})
```

**Note for the implementer:** `ai.embed(...)` above is a placeholder for however this codebase produces a query embedding — `retrieveChunks` in `packages/foundation/ai/src/retrieve.ts` builds a `vectorStr` from an embedding call before the query. Reuse that exact mechanism rather than inventing one; if it is not exported, export it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/findInFolder.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the tool and commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/findInFolder.ts \
        apps/agent-orchestrator/src/mastra/tools/__tests__/findInFolder.test.ts \
        apps/agent-orchestrator/src/mastra/agents
git commit -m "feat(agent): add find_in_folder, which routes to files"
```

---

## Task 8: `read_file` — read one file, dispatch by type

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/readFile.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/readFile.test.ts`

**Interfaces:**
- Consumes: `assertFileInGrant` (Task 4), existing `analyzeAudio` / `analyzeVideo`.
- Produces: tool `read_file`, input `{ fileId: string }`, output `{ content: string, filename: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'

const assertFileInGrant = vi.fn()
const analyzeAudioExec = vi.fn().mockResolvedValue({ text: 'transcript' })
vi.mock('../folderScope.js', () => ({ assertFileInGrant, listGrantedFiles: vi.fn() }))
vi.mock('../analyzeAudio.js', () => ({ analyzeAudio: { execute: analyzeAudioExec } }))
const { readFile } = await import('../readFile.js')

const ctx = (v: Record<string, string>) => ({ requestContext: { get: (k: string) => v[k] } })

describe('read_file', () => {
  it('refuses a file outside the grant before reading anything', async () => {
    assertFileInGrant.mockRejectedValue(new Error('file is outside the granted folder'))
    const out = await readFile.execute({ fileId: 'f-elsewhere' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }) as never)
    expect(out.content).toContain('outside the granted folder')
    expect(analyzeAudioExec).not.toHaveBeenCalled()
  })

  it('routes audio to analyzeAudio', async () => {
    assertFileInGrant.mockResolvedValue({ fileId: 'f1', filename: 'call.mp3', contentType: 'audio/mpeg', size: 1, createdAt: 'x' })
    const out = await readFile.execute({ fileId: 'f1' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }) as never)
    expect(analyzeAudioExec).toHaveBeenCalled()
    expect(out.content).toBe('transcript')
  })

  it('refuses when no folder is granted', async () => {
    const out = await readFile.execute({ fileId: 'f1' }, ctx({ tenantId: 't1' }) as never)
    expect(out.content).toContain('No folder has been granted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/readFile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { assertFileInGrant } from './folderScope.js'
import { analyzeAudio } from './analyzeAudio.js'
import { analyzeVideo } from './analyzeVideo.js'

export const readFile = createTool({
  id: 'read_file',
  description: 'Read one file from the granted folder. Use find_in_folder or list_folder first to choose which. Reading is slow and expensive — read one file, not several.',
  inputSchema: z.object({ fileId: z.string() }),
  outputSchema: z.object({ content: z.string(), filename: z.string() }),
  execute: async ({ fileId }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
    const prefix = (execContext as any)?.requestContext?.get('folderPrefix') as string | undefined
    if (!tenantId || !prefix) {
      return { content: 'No folder has been granted to this conversation.', filename: '' }
    }

    // Enforcement happens before a byte is fetched: the model supplies the
    // fileId, so the grant is the only thing standing between it and any file
    // in the tenant.
    let file
    try {
      file = await assertFileInGrant(tenantId, prefix, fileId)
    } catch (err) {
      return { content: (err as Error).message, filename: '' }
    }

    const type = file.contentType
    if (type.startsWith('audio/')) {
      const out = await analyzeAudio.execute({ fileId, mode: 'deep' } as never, execContext)
      return { content: (out as { text: string }).text, filename: file.filename }
    }
    if (type.startsWith('video/')) {
      const out = await analyzeVideo.execute({ fileId, mode: 'deep' } as never, execContext)
      return { content: (out as { text: string }).text, filename: file.filename }
    }
    return {
      content: `Reading ${type} is not supported yet. This file is in the folder but cannot be opened.`,
      filename: file.filename,
    }
  },
})
```

**Note for the implementer:** documents and images fall into the final branch. Documents are the higher-value gap — wire them to whatever `geminiExtract` exposes if its interface fits; if it does not, leave the branch as-is rather than reshaping that tool inside this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/__tests__/readFile.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the tool and commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/readFile.ts \
        apps/agent-orchestrator/src/mastra/tools/__tests__/readFile.test.ts \
        apps/agent-orchestrator/src/mastra/agents
git commit -m "feat(agent): add read_file, enforced against the grant"
```

---

## Task 9: Grant a folder from Drive, and show it in the chat

**Files:**
- Create: `apps/web/components/platform/chat/FolderScopeChip.tsx`
- Modify: `apps/web/components/platform/files/FilesList.tsx:80-82`, `apps/web/components/platform/files/components/FileListView.tsx`, `apps/web/components/platform/files/components/FileGridView.tsx`
- Test: `apps/web/components/platform/chat/folderScopeChip.test.ts`

**Interfaces:**
- Consumes: `PATCH /conversations/:id` with `folderScope` (Task 3).
- Produces: `grantFolderToChat(conversationId: string | null, prefix: string)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { folderDisplayName } from '@/components/platform/chat/FolderScopeChip'

describe('folderDisplayName', () => {
  it('shows the folder name, not the whole prefix', () => {
    expect(folderDisplayName('projects/2026/new/')).toBe('new')
  })

  it('handles a top-level folder', () => {
    expect(folderDisplayName('new/')).toBe('new')
  })

  it('returns empty for an empty prefix', () => {
    expect(folderDisplayName('')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run components/platform/chat/folderScopeChip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chip and the grant action**

```typescript
export function folderDisplayName(prefix: string): string {
  const parts = prefix.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}
```

The chip renders `folderDisplayName(prefix)` with a remove button that PATCHes `folderScope: null`. Render it above the composer, always visible while a grant exists — sticky reach must be visible, which is the condition the design attaches to choosing sticky over per-message.

In `FilesList.tsx`, `addFolderToChat` currently attaches every file under the prefix. Replace its body with a grant: PATCH the target conversation's `folderScope`, then navigate. Creating a new conversation grants after creation, since the id does not exist until then.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run components/platform/chat/folderScopeChip.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full suite, then commit**

Run: `cd apps/web && pnpm type-check && pnpm test`
Expected: all pass.

```bash
git add apps/web/components/platform/chat/FolderScopeChip.tsx \
        apps/web/components/platform/chat/folderScopeChip.test.ts \
        apps/web/components/platform/files
git commit -m "feat(drive): grant a folder to a chat instead of attaching it"
```

Deploy: `./deploy.sh` on the VM.

At this point the feature works end to end: folders are granted, listed, routed by filename and by any indexed document text, and read on demand with enforcement. The remaining tasks improve ranking for media.

---

## Task 10 (contingent): Tier 2 — the quick pass on media

**Blocked.** The spec's Open section lists four undecided pieces: what process runs it, how work reaches it, what happens when it is down, and retry policy. `analyzeAudio` / `analyzeVideo` call the inference gateway on the VM's `localhost:4001`, which the Lambda worker cannot reach, so this cannot simply extend `file.ingest`.

Do not start this task until that decision is recorded in the spec. When it is, the work is:

- A VM-side consumer that, for each media file, runs the existing quick mode (45 s, 1–2 sentence summary).
- Persist the result so `find_in_folder` can rank on it — as a `document` + one `document_chunk` per file, so it joins the path Task 7 already queries rather than adding a second store.
- Failure marks `files.ingestion_status = 'failed'` and leaves the file listable, since tier 1 does not depend on it.
- Retry needs an attempt counter on `files`; there is none today, which is why the watchdog marks stalls failed and never retries.

**Acceptance:** two media files whose names are generator prefixes (`hf_20260817_212810_…`, `hf_20260816_163114_…`) are distinguishable by `find_in_folder` after the pass and are not before it.

## Task 11 (contingent): Tier 3 — cache what a deep read produced

**Blocked on Task 10.** When `read_file` runs a deep pass, persist the transcript the same way, so a second question about the same file does not pay 150 s again.

---

## Risks

- **`find_in_folder` ranking quality is unproven.** Every document in dev currently has exactly **1 chunk** (verified across the 20 joinable documents). If that reflects chunking rather than tiny files, ranking is coarse and the tier-2 gap will look worse than it is. Check chunk counts on a real multi-page document before concluding the router is at fault.
- **4 of 24 documents have no matching file** — including `IIM-Jammu-2026.pdf`, the file stuck in `processing` since 20 Aug. Those are invisible to `find_in_folder` by construction, since it starts from granted files.
- **`ai.embed` in Task 7 is a placeholder** for this codebase's embedding call. Reuse `retrieve.ts`'s mechanism; do not invent one.
