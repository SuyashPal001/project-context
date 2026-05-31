import { createStep } from '@mastra/core/workflows'
import { detectFormat } from '../tools/detectFormat.js'
import { workflowInputSchema, detectFormatOutputSchema } from './ingestionWorkflow.schemas.js'

export const detectFormatStep = createStep({
  id: 'ingestion-detect-format',
  inputSchema: workflowInputSchema,
  outputSchema: detectFormatOutputSchema,
  execute: async ({ inputData }) => {
    const result = detectFormat(
      inputData.filename,
      inputData.mimeType,
      inputData.extractedText?.length ?? 0,
      inputData.extractedText,
    )
    return { ...inputData, ...result }
  },
})
