import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[listFolderDocuments] pool error:', (err as Error).message))
  }
  return _pool
}

const requestContextSchema = z.object({
  tenantId: z.string(),
})

export const listFolderDocumentsTool = createTool({
  id: 'list_folder_documents',
  description: `List all documents uploaded to a person folder.
Call this when you need to know which documents are present before checking for missing ones.
Returns filenames, mime types, and ingest status.`,

  inputSchema: z.object({
    folderId: z.string().describe('The person folder ID'),
    tenantId: z.string().describe('The tenant ID'),
  }),

  requestContextSchema,

  outputSchema: z.object({
    found:     z.boolean(),
    documents: z.array(z.object({
      id:       z.string(),
      name:     z.string(),
      mimeType: z.string(),
      status:   z.string(),
    })),
  }),

  execute: async ({ folderId }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
      ?? (execContext as any)?.context?.tenantId as string | undefined
      ?? ''
    const client = await getPool().connect()
    try {
      const result = await client.query(`
        SELECT f.id, f.name, f.mime_type, f.status
        FROM files f
        WHERE f.tenant_id = $2
          AND f.deleted_at IS NULL
          AND (
            f.person_folder_id = $1
            OR f.key LIKE (
              SELECT pf.identifier || '/%'
              FROM person_folders pf
              WHERE pf.id = $1
              LIMIT 1
            )
          )
        ORDER BY f.created_at DESC
      `, [folderId, tenantId])

      const documents = result.rows.map((r: any) => ({
        id:       r.id,
        name:     r.name ?? '',
        mimeType: r.mime_type ?? '',
        status:   r.status ?? '',
      }))

      return { found: documents.length > 0, documents }
    } finally {
      client.release()
    }
  },
})
