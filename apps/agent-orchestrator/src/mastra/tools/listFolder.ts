import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { listGrantedFiles } from './folderScope.js'

/**
 * Tier 1 of the folder-scope design: the manifest.
 *
 * Returns what is in the granted folder — names, types, sizes — and nothing
 * else. Contents stay unread until the agent asks for a specific file, which is
 * the whole point: the agent holds a handle to the folder rather than a copy of
 * everything in it.
 *
 * The folder is never a tool argument. It comes from the request context, so
 * the model cannot widen its own reach by naming a different one.
 */
export const listFolderTool = createTool({
  id: 'list_folder',
  description: 'List the files in the folder granted to this conversation. Returns names, types and sizes — not contents. Use this before reading anything.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(z.object({
      fileId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
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
    if (files.length === 0) {
      // Distinguished from the ungranted case: "the folder is empty" and "you
      // have no folder" call for different next moves from the agent.
      return { files: [], note: 'The granted folder is empty.' }
    }

    return {
      files: files.map(({ fileId, filename, contentType, size }) => ({
        fileId, filename, contentType, size,
      })),
    }
  },
})
