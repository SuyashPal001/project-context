import { createStep } from '@mastra/core/workflows';
import { validatePensionCase } from '../tools/validatePensionCase.js';
import { fieldValidationOutputSchema, ruleValidationOutputSchema } from './pensionWorkflow.schemas.js';

export const ruleValidationStep = createStep({
  id: 'pension-rule-validation',
  inputSchema: fieldValidationOutputSchema,
  outputSchema: ruleValidationOutputSchema,
  execute: async ({ inputData }) => {
    const ruleResults = validatePensionCase(inputData.fields);
    return { ...inputData, ruleResults };
  },
});
