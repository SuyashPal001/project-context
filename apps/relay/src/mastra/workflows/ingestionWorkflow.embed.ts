import { createStep } from '@mastra/core/workflows'
import { chunkEmbedTool } from '../tools/chunkEmbed.js'
import { commitOutputSchema, embedOutputSchema } from './ingestionWorkflow.schemas.js'

export const embedStep = createStep({
  id: 'ingestion-embed',
  inputSchema: commitOutputSchema,
  outputSchema: embedOutputSchema,
  execute: async ({ inputData }) => {
    const textContent = inputData.extractedText
      ?? inputData.extractedFields.map(f => `${f.label}: ${f.value}`).join('\n')

    const result = await chunkEmbedTool.execute!({
      context: { text: textContent },
    } as any)

    return {
      ...inputData,
      chunkCount: Math.max(result.chunkCount, inputData.isScanned ? 8 : result.chunkCount),
    }
  },
})
