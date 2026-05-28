import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db } from '@serverless-saas/database'
import { sql } from 'drizzle-orm'

export const listFolderDocumentsTool = createTool({
  id: 'list_folder_documents',
  description: `List all documents uploaded to a person folder.
Call this when you need to know which documents are present before checking for missing ones.
Returns filenames, mime types, and ingest status.`,

  inputSchema: z.object({
    folderId: z.string().describe('The person folder ID'),
    tenantId: z.string().describe('The tenant ID'),
  }),

  outputSchema: z.object({
    found:     z.boolean(),
    documents: z.array(z.object({
      id:       z.string(),
      name:     z.string(),
      mimeType: z.string(),
      status:   z.string(),
    })),
  }),

  execute: async ({ folderId, tenantId }) => {
    const rows = await db.execute(sql`
      SELECT id, name, mime_type, status
      FROM files
      WHERE person_folder_id = ${folderId}
        AND tenant_id        = ${tenantId}
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `)

    const documents = ((rows as any).rows ?? []).map((r: any) => ({
      id:       r.id,
      name:     r.name ?? r.original_name ?? '',
      mimeType: r.mime_type ?? '',
      status:   r.status ?? '',
    }))

    return { found: documents.length > 0, documents }
  },
})
