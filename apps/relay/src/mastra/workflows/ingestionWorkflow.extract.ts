import { createStep } from '@mastra/core/workflows'
import { geminiExtract } from '../tools/geminiExtract.js'
import { classifyOutputSchema, extractOutputSchema } from './ingestionWorkflow.schemas.js'

export const extractStep = createStep({
  id: 'ingestion-extract',
  inputSchema: classifyOutputSchema,
  outputSchema: extractOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData.isScanned) {
      return { ...inputData, extractedFields: [] }
    }
    const result = await geminiExtract(inputData.bufferBase64, inputData.mimeType, inputData.documentType)
    return { ...inputData, extractedFields: result.fields }
  },
})
