import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { assertFileInGrant } from './folderScope.js'
import { analyzeAudioTool } from './analyzeAudio.js'
import { analyzeVideoTool } from './analyzeVideo.js'

/** Both analysis tools answer with { success, error } and differ only in which
 *  field carries the result — transcript for audio, summary for video. */
interface AnalysisResult {
  success?: boolean
  transcript?: string
  summary?: string
  partial?: boolean
  error?: string
}

function contentFrom(result: AnalysisResult, kind: 'transcript' | 'summary'): string {
  const text = kind === 'transcript' ? result.transcript : result.summary
  if (result.success && text) return text
  // Never hand back empty content on failure: the agent would read that as "the
  // file is blank" and answer as though it had seen it.
  return `Could not read this file: ${result.error ?? 'analysis returned no content'}.`
}

/**
 * Reads one file from the granted folder, dispatching by type.
 *
 * The model supplies the fileId, so assertFileInGrant is the only thing between
 * it and every file in the tenant. Enforcement runs before a byte is fetched
 * and lives in the tool, never in a prompt.
 */
export const readFileTool = createTool({
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

    let file
    try {
      file = await assertFileInGrant(tenantId, prefix, fileId)
    } catch (err) {
      return { content: (err as Error).message, filename: '' }
    }

    const type = file.contentType
    if (type.startsWith('audio/')) {
      const out = await analyzeAudioTool.execute!({ fileId, mode: 'deep' } as never, execContext)
      return { content: contentFrom(out as AnalysisResult, 'transcript'), filename: file.filename }
    }
    if (type.startsWith('video/')) {
      const out = await analyzeVideoTool.execute!({ fileId, mode: 'deep' } as never, execContext)
      return { content: contentFrom(out as AnalysisResult, 'summary'), filename: file.filename }
    }

    // Documents and images land here. geminiExtract takes base64 image data
    // rather than a fileId, so wiring it would mean reshaping that tool — out of
    // scope. Indexed documents are already reachable, so the message points at
    // the tool that does work rather than reading as a dead end.
    return {
      content: `This file is in the folder but ${type} cannot be opened directly yet. `
        + 'If it is a document, its indexed text is searchable — use find_in_folder to locate the relevant passage.',
      filename: file.filename,
    }
  },
})
