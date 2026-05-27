import { createStep } from '@mastra/core/workflows';
import { checkRequiredDocuments } from '../tools/checkRequiredDocuments.js';
import { pensionInputSchema, completenessOutputSchema } from './pensionWorkflow.schemas.js';

export const completenessStep = createStep({
  id: 'pension-completeness-check',
  inputSchema: pensionInputSchema,
  outputSchema: completenessOutputSchema,
  execute: async ({ inputData }) => {
    const { complete, missing } = checkRequiredDocuments(inputData.presentDocs);
    return { ...inputData, complete, missingDocs: missing };
  },
});
