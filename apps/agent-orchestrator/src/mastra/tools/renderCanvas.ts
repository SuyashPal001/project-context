import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { uploadGeneratedFile } from '../../persistence.js'

export const renderCanvas = createTool({
  id: 'render-canvas',
  description:
    'Display rich content on the canvas panel — use this whenever your response is long, structured, or would benefit from a dedicated document view. ' +
    'Call it for analyses, plans, comparisons, summaries, code explanations, or any output the user will want to read, scroll, or copy. ' +
    'Do NOT call it for short conversational replies or simple one-liners.',
  inputSchema: z.object({
    title: z.string().describe('Short title shown in the canvas tab (e.g. "Q3 Roadmap Analysis")'),
    content: z.string().describe('Full markdown content to display on the canvas'),
    type: z
      .enum(['document', 'prd', 'roadmap', 'tasks'])
      .optional()
      .default('document')
      .describe('Canvas panel display mode — use "document" for general content'),
  }),
  outputSchema: z.object({
    title: z.string(),
    content: z.string(),
    type: z.string(),
    fileId: z.string().optional(),
    name: z.string().optional(),
    fileType: z.string().optional(),
    size: z.number().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { title, content, type } = inputData as { title: string; content: string; type?: string }

    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined

    // Persistence is best-effort: the canvas has already been streamed to the
    // user by the time this runs, so a failed upload should cost the
    // downloadable attachment, not the reply.
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, { conversationId, title, content })
      : null

    return {
      title,
      content,
      type: type ?? 'document',
      ...(attachment
        ? { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
        : {}),
    }
  },
})
