import { createWorkflow } from '@mastra/core/workflows'
import { workflowInputSchema, composeOutputSchema } from './documentWorkflow.schemas.js'
import { planStep, extractStep } from './documentWorkflow.plan.js'
import { docDodVerifyStep, docComposeStep } from './documentWorkflow.verify.js'

// Subsequent steps use `as any` due to Mastra's .then() type-narrowing limits —
// same pattern as taskExecution.ts.

export const documentWorkflow = createWorkflow({
  id: 'document-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: composeOutputSchema,
})
  .then(planStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(extractStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(docDodVerifyStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(docComposeStep as any)
  .commit()
