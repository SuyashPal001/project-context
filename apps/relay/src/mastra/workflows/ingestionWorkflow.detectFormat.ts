import { createStep } from '@mastra/core/workflows'
import { detectFormatTool } from '../tools/detectFormat.js'
import { workflowInputSchema, detectFormatOutputSchema } from './ingestionWorkflow.schemas.js'

export const detectFormatStep = createStep({
  id: 'ingestion-detect-format',
  inputSchema: workflowInputSchema,
  outputSchema: detectFormatOutputSchema,
  execute: async ({ inputData }) => {
    const result = await detectFormatTool.execute!({
      context: {
        filename: inputData.filename,
        mimeType: inputData.mimeType,
        textLength: inputData.extractedText?.length ?? 0,
        extractedText: inputData.extractedText,
      },
    } as any)
    return {
      ...inputData,
      formatDetected: result.formatDetected,
      isScanned: result.isScanned,
    }
  },
})
