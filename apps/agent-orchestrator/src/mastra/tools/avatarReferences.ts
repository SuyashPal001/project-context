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

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Array<{ file_id: string; sheet: string }> }>

/**
 * A tenant avatar's portrait alone is a weak identity anchor; its reference
 * sheet (front, 3/4, profile, full body) is what keeps the face stable. When a
 * portrait is passed as a reference, add its sheet right after it — without
 * ever dropping an original reference or passing more than 3. Never throws:
 * on any failure the references are used as given.
 */
export async function expandAvatarReferences(tenantId: string, fileIds: string[], query: Query = (sql, params) => pool().query(sql, params)): Promise<string[]> {
  if (!tenantId || fileIds.length === 0 || fileIds.length >= MAX_REFERENCES) return fileIds
  try {
    const { rows } = await query(
      `SELECT a.file_id, a.attributes->>'referenceSheetFileId' AS sheet
       FROM creative_library_assets a
       JOIN files s ON s.id = (a.attributes->>'referenceSheetFileId')::uuid
       WHERE a.tenant_id = $1::uuid AND a.status = 'active' AND a.kind = 'avatar' AND a.file_id = ANY($2::uuid[])
         AND s.tenant_id = $1::uuid AND s.deleted_at IS NULL`,
      [tenantId, fileIds],
    )
    const sheetByPortrait = new Map(rows.map((r) => [r.file_id, r.sheet]))
    let room = MAX_REFERENCES - fileIds.length
    const out: string[] = []
    for (const id of fileIds) {
      out.push(id)
      const sheet = sheetByPortrait.get(id)
      if (sheet && room > 0 && !fileIds.includes(sheet) && !out.includes(sheet)) { out.push(sheet); room-- }
    }
    return out
  } catch (err) {
    console.error('[avatarReferences] lookup failed, using references as given:', (err as Error).message)
    return fileIds
  }
}
