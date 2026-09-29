import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { executeSql } from './folderScope.js'
import { sql } from 'drizzle-orm'
import { tenantContextSchema } from '../context.js'

// db.execute returns a bare array on some drivers and { rows } on others —
// same dance as folderScope.ts's rowsOf.
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown }
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>
}

export interface ShownFile {
  fileId: string
  name: string
  fileType: string
  size?: number
}

/**
 * Tenant-scoped, unlike folderScope.ts's assertFileInGrant — show_files re-shows
 * anything the tenant owns (an earlier tool result's fileId), not just files
 * inside one granted Drive folder. The tenant filter is the only thing standing
 * between the model and another tenant's file.
 */
export async function fetchTenantFile(tenantId: string, fileId: string): Promise<ShownFile | null> {
  if (!tenantId || !fileId) return null
  const result = await executeSql(sql`
    SELECT id AS file_id, name, mime_type, size
    FROM files
    WHERE tenant_id = ${tenantId} AND id = ${fileId} AND deleted_at IS NULL
    LIMIT 1
  `)
  const row = rowsOf(result)[0]
  if (!row) return null
  return {
    fileId: String(row.file_id),
    name: row.name ? String(row.name) : '',
    fileType: row.mime_type ? String(row.mime_type) : 'application/octet-stream',
    size: row.size != null ? Number(row.size) : undefined,
  }
}

// Olmo has no tool to re-show a file already generated or attached earlier in
// this conversation — without this, it flails (check_credit_plan,
// find_past_tasks, or worse, re-generating) when the user just says "show me
// the ones already generated". Free, no approval gate: this never spends
// credits or creates anything, only re-surfaces a fileId the model already has
// from an earlier tool result. The web renders the output the same way it
// renders a generate_image result (see ToolCallCard's extractResultFiles).
export const showFilesTool = createTool({
  id: 'show_files',
  description:
    'Re-show one or more files already generated or attached earlier in THIS conversation, by the ' +
    'fileId an earlier tool result gave you. Free, no approval needed. Use this — never ' +
    'find_past_tasks, never re-generating — whenever the user asks to see something already made ' +
    'or attached in this conversation.',
  requestContextSchema: tenantContextSchema,
  inputSchema: z.object({
    fileIds: z.array(z.string().uuid()).min(1).max(12).describe('fileId(s) from an earlier tool result in this conversation'),
  }),
  outputSchema: z.object({
    files: z.array(z.object({
      fileId: z.string(),
      name: z.string(),
      fileType: z.string(),
      size: z.number().optional(),
    })),
    missing: z.array(z.string()).describe('fileIds that do not belong to this tenant, or do not exist'),
  }),
  execute: async (inputData, execContext) => {
    const { fileIds } = inputData as { fileIds: string[] }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined

    if (!tenantId) return { files: [], missing: fileIds }

    const files: ShownFile[] = []
    const missing: string[] = []
    for (const fileId of fileIds) {
      const file = await fetchTenantFile(tenantId, fileId)
      if (file) files.push(file)
      else missing.push(fileId)
    }
    return { files, missing }
  },
})
