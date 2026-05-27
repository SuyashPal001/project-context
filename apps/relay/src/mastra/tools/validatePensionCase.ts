import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { evaluateRules, type RuleResult } from '../rules/ccsRules.js';

export function validatePensionCase(fields: Record<string, number>): RuleResult[] {
  return evaluateRules(fields);
}

export const validatePensionCaseTool = createTool({
  id: 'validate-pension-case',
  description: 'Validates a pension case against CCS Pension Rules 1972. Deterministic — no LLM. Returns one result per rule.',
  inputSchema: z.object({ fields: z.record(z.string(), z.number()) }),
  outputSchema: z.array(z.object({
    ruleId: z.string(), ruleName: z.string(),
    status: z.enum(['pass', 'fail', 'cannot_evaluate']),
    provision: z.string(), inputs: z.array(z.string()),
    declared: z.number().nullable(), calculated: z.number().nullable(), message: z.string(),
  })),
  execute: async (inputData) => validatePensionCase(inputData.fields),
});
