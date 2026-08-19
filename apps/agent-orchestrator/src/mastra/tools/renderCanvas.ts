import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

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
  }),
  execute: async (inputData) => {
    const { title, content, type } = inputData as { title: string; content: string; type?: string }
    return { title, content, type: type ?? 'document' }
  },
})
