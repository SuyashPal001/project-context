import { sql } from 'drizzle-orm'
import { executeSql } from '../tools/folderScope.js'

// Olmo names the files a delegate should build on as "<what> reference: <id>"
// lines in its delegation prompt. On 2026-10-08 it wrote "joined video
// reference: 6fb4f21d…" for a video that was never made (the clips' approval
// had been lost), and the Director spent a turn on narration and three
// finishing tools that all refused SOURCE_UNAVAILABLE. A reference that is
// not a real file stops the delegation before anything runs.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// Allows a list marker ("- ", "1. ") and markdown bold around the label.
const REFERENCE_LINE = new RegExp(`^[ \\t]*(?:[-*•][ \\t]+|\\d+[.)][ \\t]+)?\\**((?:[A-Za-z0-9][A-Za-z0-9 _-]*? )?reference(?: [A-Za-z]+)?)[ \\t]*:\\**[ \\t]*[\`'"(]?(${UUID})`, 'gim')

export interface FileReference { label: string; fileId: string }

/** The "<what> reference: <id>" lines of a delegation prompt, once per id. */
export function referencedFiles(prompt: string): FileReference[] {
  const seen = new Set<string>()
  const refs: FileReference[] = []
  for (const m of prompt.matchAll(REFERENCE_LINE)) {
    const fileId = m[2].toLowerCase()
    if (seen.has(fileId)) continue
    seen.add(fileId)
    refs.push({ label: m[1].trim(), fileId })
  }
  return refs
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown }
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>
}

/** The ids that are this tenant's files, or library assets it can use (platform-owned or its own). */
export async function existingFileIds(tenantId: string, ids: string[]): Promise<Set<string>> {
  if (!tenantId || ids.length === 0) return new Set()
  const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)
  const result = await executeSql(sql`
    SELECT id::text AS id FROM files
    WHERE tenant_id = ${tenantId} AND id IN (${list}) AND deleted_at IS NULL
    UNION
    SELECT id::text AS id FROM creative_library_assets
    WHERE id IN (${list}) AND (tenant_id IS NULL OR tenant_id = ${tenantId})
    UNION
    -- A template's reference ad is a platform file, owned by no tenant of ours.
    SELECT reference_file_id::text AS id FROM creative_templates
    WHERE reference_file_id IN (${list})
  `)
  return new Set(rowsOf(result).map(r => String(r.id).toLowerCase()))
}

/** Why the delegation must not run, or null when every reference is a real file. */
export async function missingReferenceReason(
  tenantId: string,
  prompt: string,
  lookup: typeof existingFileIds = existingFileIds,
): Promise<string | null> {
  const refs = referencedFiles(prompt)
  if (refs.length === 0) return null
  let existing: Set<string>
  try {
    existing = await lookup(tenantId, refs.map(r => r.fileId))
  } catch (err) {
    // A failed lookup must not block real work; the tools still refuse a bad file.
    console.error('[reference-check] lookup failed:', (err as Error).message)
    return null
  }
  const missing = refs.filter(r => !existing.has(r.fileId))
  if (missing.length === 0) return null
  const list = missing.map(r => `"${r.label}" (${r.fileId})`).join(', ')
  return `Not delegated: ${list} ${missing.length === 1 ? 'is' : 'are'} not a file in this workspace, so nothing was made. ` +
    'Use only file ids a tool actually returned in this chat. If that file was never made, make it first, then delegate again. ' +
    'Remove the id from working memory if it is there.'
}
