import { createStep } from '@mastra/core/workflows'
import { geminiExtractTool } from '../tools/geminiExtract.js'
import { classifyOutputSchema, extractOutputSchema } from './ingestionWorkflow.schemas.js'

export const extractStep = createStep({
  id: 'ingestion-extract',
  inputSchema: classifyOutputSchema,
  outputSchema: extractOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData.isScanned) {
      return { ...inputData, extractedFields: [] }
    }

    const result = await geminiExtractTool.execute!({
      context: {
        imageBase64: inputData.bufferBase64,
        mimeType: inputData.mimeType,
        documentType: inputData.documentType,
      },
    } as any)

    return {
      ...inputData,
      extractedFields: result.fields,
    }
  },
})
