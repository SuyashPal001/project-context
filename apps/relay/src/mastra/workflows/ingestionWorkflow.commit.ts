import { createStep } from '@mastra/core/workflows'
import { lakehouseCommit } from '../tools/lakehouseCommit.js'
import { validateOutputSchema, commitOutputSchema } from './ingestionWorkflow.schemas.js'

export const commitStep = createStep({
  id: 'ingestion-commit-lakehouse',
  inputSchema: validateOutputSchema,
  outputSchema: commitOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.extractedFields.length === 0) {
      return { ...inputData, lakehouseVersion: -1, lakehouseLabel: 'No fields to commit' }
    }
    const result = await lakehouseCommit(inputData.extractedFields, inputData.filename, inputData.fileId, inputData.tenantId)
    return { ...inputData, lakehouseVersion: result.version, lakehouseLabel: result.label }
  },
})
