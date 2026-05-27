import { createWorkflow } from '@mastra/core/workflows';
import { pensionInputSchema, auditCommitOutputSchema } from './pensionWorkflow.schemas.js';
import { completenessStep } from './pensionWorkflow.completeness.js';
import { fieldValidationStep } from './pensionWorkflow.fieldValidation.js';
import { ruleValidationStep } from './pensionWorkflow.ruleValidation.js';
import { findingAssemblyStep } from './pensionWorkflow.findingAssembly.js';
import { routeToOfficerStep } from './pensionWorkflow.routeToOfficer.js';
import { auditCommitStep } from './pensionWorkflow.auditCommit.js';

export const pensionWorkflow = createWorkflow({
  id: 'pension-pre-scrutiny',
  inputSchema: pensionInputSchema,
  outputSchema: auditCommitOutputSchema,
})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(completenessStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(fieldValidationStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(ruleValidationStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(findingAssemblyStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(routeToOfficerStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(auditCommitStep as any)
  .commit();
