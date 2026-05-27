import { createStep } from '@mastra/core/workflows';
import { routeOutputSchema, auditCommitOutputSchema } from './pensionWorkflow.schemas.js';

// Phase 6 will replace the body with a lakehouse freeze. Pass-through for now so the
// Postgres path is fully working and demoable first.
export const auditCommitStep = createStep({
  id: 'pension-audit-commit',
  inputSchema: routeOutputSchema,
  outputSchema: auditCommitOutputSchema,
  execute: async ({ inputData }) => ({ ...inputData, lakehouseVersion: -1 }),
});
