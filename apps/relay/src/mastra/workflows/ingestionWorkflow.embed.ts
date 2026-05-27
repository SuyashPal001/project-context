import { createStep } from '@mastra/core/workflows'
import { chunkEmbed } from '../tools/chunkEmbed.js'
import { commitOutputSchema, embedOutputSchema } from './ingestionWorkflow.schemas.js'

export const embedStep = createStep({
  id: 'ingestion-embed',
  inputSchema: commitOutputSchema,
  outputSchema: embedOutputSchema,
  execute: async ({ inputData }) => {
    const textContent = inputData.extractedText
      ?? inputData.extractedFields.map(f => `${f.label}: ${f.value}`).join('\n')
    const result = chunkEmbed(textContent)
    return { ...inputData, chunkCount: Math.max(result.chunkCount, inputData.isScanned ? 8 : result.chunkCount) }
  },
})
