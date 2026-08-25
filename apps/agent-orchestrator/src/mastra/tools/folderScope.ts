import { sql, type SQL } from 'drizzle-orm'
import { db } from '@serverless-saas/database'

/**
 * Shared by the folder tools.
 *
 * drizzle-orm ships separate ESM and CJS type declarations. This package is ESM
 * and resolves `sql` through the ESM ones, while `db` arrives from
 * @serverless-saas/database typed through the CJS ones, so tsc sees two
 * structurally identical SQL classes with separate private fields and rejects
 * the call. The cast is type-only and changes nothing at runtime: the argument
 * is a real parameterised SQL object and its parameters stay bound, so no value
 * is ever interpolated into the statement text.
 */
export function executeSql(query: SQL): Promise<unknown> {
  return (db.execute as unknown as (q: SQL) => Promise<unknown>)(query)
}

export interface GrantedFile {
  fileId: string
  filename: string
  contentType: string
  size: number
  createdAt: string
}

/**
 * A granted prefix reaches the database inside a LIKE pattern, so its
 * metacharacters have to be neutralised. The API validates the prefix against
 * traversal and requires a trailing slash, but says nothing about `%` or `_`:
 * without this, a grant of "a%/" becomes `key LIKE 'a%/%'` and quietly covers
 * every folder beginning with "a". The backslash is escaped first, or an
 * escape could itself be escaped away.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// db.execute returns a bare array on some drivers and { rows } on others —
// retrieve.ts:128 does the same dance rather than assuming either.
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown }
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>
}

// Columns are `name` and `mime_type`; the API layer is what renames them to
// filename/contentType for the frontend. size and mime_type are both nullable —
// size is only set once an upload is confirmed.
function toGrantedFile(r: Record<string, unknown>): GrantedFile {
  return {
    fileId: String(r.file_id),
    filename: String(r.name),
    contentType: r.mime_type ? String(r.mime_type) : 'application/octet-stream',
    size: Number(r.size ?? 0),
    createdAt: String(r.created_at),
  }
}

/**
 * Membership is resolved, never stored: a file uploaded after the grant is
 * included automatically, and renaming a folder is one grant to update rather
 * than a re-tag of every chunk. The tenant filter is not optional — S3 keys
 * carry no tenant segment, so `key LIKE 'new/%'` alone would cross tenants.
 */
export async function listGrantedFiles(tenantId: string, prefix: string): Promise<GrantedFile[]> {
  if (!tenantId || !prefix) return []
  const pattern = `${escapeLikePrefix(prefix)}%`
  const result = await executeSql(sql`
    SELECT id AS file_id, name, mime_type, size, created_at
    FROM files
    WHERE tenant_id = ${tenantId}
      AND key LIKE ${pattern}
      AND deleted_at IS NULL
      AND status = 'uploaded'
    ORDER BY created_at DESC
  `)
  return rowsOf(result).map(toGrantedFile)
}

/**
 * The model supplies the fileId, so this is the only thing standing between it
 * and any file in the tenant. Enforcement happens here, before a byte is
 * fetched — never in a prompt.
 */
export async function assertFileInGrant(
  tenantId: string, prefix: string, fileId: string,
): Promise<GrantedFile> {
  // One message for "wrong tenant", "outside the folder" and "does not exist":
  // distinguishing them would tell the model whether a file it cannot reach
  // exists at all.
  const denied = new Error('file is outside the granted folder')
  if (!tenantId || !prefix || !fileId) throw denied

  const pattern = `${escapeLikePrefix(prefix)}%`
  const result = await executeSql(sql`
    SELECT id AS file_id, name, mime_type, size, created_at
    FROM files
    WHERE tenant_id = ${tenantId}
      AND id = ${fileId}
      AND key LIKE ${pattern}
      AND deleted_at IS NULL
      AND status = 'uploaded'
    LIMIT 1
  `)
  const row = rowsOf(result)[0]
  if (!row) throw denied
  return toGrantedFile(row)
}
