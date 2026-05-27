import { createStep } from '@mastra/core/workflows';
import { completenessOutputSchema, fieldValidationOutputSchema } from './pensionWorkflow.schemas.js';

// Any field absent from fieldSources is treated as low-confidence (no provenance == unverified).
export const fieldValidationStep = createStep({
  id: 'pension-field-validation',
  inputSchema: completenessOutputSchema,
  outputSchema: fieldValidationOutputSchema,
  execute: async ({ inputData }) => {
    const lowConfidenceFields = Object.keys(inputData.fields)
      .filter(k => !(k in inputData.fieldSources));
    return { ...inputData, lowConfidenceFields };
  },
});
