import { createStep } from '@mastra/core/workflows'
import { validateOutputSchema, commitOutputSchema } from './ingestionWorkflow.schemas.js'

export const commitStep = createStep({
  id: 'ingestion-commit',
  inputSchema: validateOutputSchema,
  outputSchema: commitOutputSchema,
  execute: async ({ inputData }) => inputData,
})
