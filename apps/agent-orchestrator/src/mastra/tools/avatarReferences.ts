import pg from 'pg'
import { makeAppPool } from '../../db.js'

const MAX_REFERENCES = 3 // generate_image's referenceFileIds cap
let _pool: pg.Pool | null = null
function pool(): pg.Pool {
  if (!_pool) {
    _pool = makeAppPool(3)
    _pool.on('error', (err) => console.error('[avatarReferences] pool error:', err.message))
  }
  return _pool
}

type Row = { file_id: string; sheet: string; terse_tag: string | null; style_lock: string | null }
type Query = (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>

export type AvatarReferenceResolution = {
  fileIds: string[]
  anchor: { terseTag: string; styleLock: string } | null
}

/**
 * A tenant avatar's portrait alone is a weak identity anchor; its reference
 * sheet (front, 3/4, profile, full body) is what keeps the face stable. When a
 * portrait is passed as a reference, add its sheet right after it — without
 * ever dropping an original reference or passing more than 3. Also surfaces
 * the first original reference's identity anchor (terseTag + styleLock), if
 * its avatar has both, for generateImage.ts to fold into the gateway prompt.
 * Never throws: on any failure the references are used as given and the
 * anchor is null.
 */
export async function resolveAvatarReferences(
  tenantId: string,
  fileIds: string[],
  query: Query = (sql, params) => pool().query(sql, params),
): Promise<AvatarReferenceResolution> {
  if (!tenantId || fileIds.length === 0 || fileIds.length >= MAX_REFERENCES) return { fileIds, anchor: null }
  try {
    const { rows } = await query(
      `SELECT a.file_id, a.attributes->>'referenceSheetFileId' AS sheet,
              a.attributes->>'terseTag' AS terse_tag, a.attributes->>'styleLock' AS style_lock
       FROM creative_library_assets a
       JOIN files s ON s.id = (a.attributes->>'referenceSheetFileId')::uuid
       WHERE a.tenant_id = $1::uuid AND a.status = 'active' AND a.kind = 'avatar' AND a.file_id = ANY($2::uuid[])
         AND s.tenant_id = $1::uuid AND s.deleted_at IS NULL`,
      [tenantId, fileIds],
    )
    const rowByPortrait = new Map(rows.map((r) => [r.file_id, r]))
    let room = MAX_REFERENCES - fileIds.length
    const out: string[] = []
    for (const id of fileIds) {
      out.push(id)
      const sheet = rowByPortrait.get(id)?.sheet
      if (sheet && room > 0 && !fileIds.includes(sheet) && !out.includes(sheet)) { out.push(sheet); room-- }
    }
    let anchor: AvatarReferenceResolution['anchor'] = null
    for (const id of fileIds) {
      const row = rowByPortrait.get(id)
      if (row?.terse_tag && row?.style_lock) {
        anchor = { terseTag: row.terse_tag, styleLock: row.style_lock }
        break
      }
    }
    return { fileIds: out, anchor }
  } catch (err) {
    console.error('[avatarReferences] lookup failed, using references as given:', (err as Error).message)
    return { fileIds, anchor: null }
  }
}

/** Thin wrapper kept for existing callers/tests that only need the resolved fileIds. */
export const expandAvatarReferences = async (
  tenantId: string,
  fileIds: string[],
  query?: Query,
): Promise<string[]> => (await resolveAvatarReferences(tenantId, fileIds, query)).fileIds
