import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, personFolders } from '@serverless-saas/database'
import { and, eq, or, sql } from 'drizzle-orm'

const requestContextSchema = z.object({
  tenantId: z.string(),
})

export const lookupPersonFolderTool = createTool({
  id: 'lookup_person_folder',
  description: `Resolve a pensioner identifier (e.g. "PB-2023-4521") to a folder ID.
Call this when the officer mentions a case identifier but folderId is not in context.
Returns folderId to use in retrieve_documents.
If not found, tell the officer the folder does not exist yet.`,

  inputSchema: z.object({
    identifier: z.string().describe('The pension/employee identifier'),
    tenantId:   z.string().describe('The tenant ID'),
  }),

  requestContextSchema,

  outputSchema: z.object({
    found:    z.boolean(),
    folderId: z.string().optional(),
    status:   z.string().optional(),
  }),

  execute: async ({ identifier }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
      ?? (execContext as any)?.context?.tenantId as string | undefined
      ?? ''
    const normalised = identifier.trim().toLowerCase()
    const [folder] = await db
      .select({ id: personFolders.id, status: personFolders.status })
      .from(personFolders)
      .where(and(
        eq(personFolders.tenantId, tenantId),
        or(
          eq(sql`lower(${personFolders.identifier})`, normalised),
          eq(sql`lower(${personFolders.displayName})`, normalised),
        )
      ))
      .limit(1)

    if (!folder) return { found: false }
    return { found: true, folderId: folder.id, status: folder.status }
  },
})
