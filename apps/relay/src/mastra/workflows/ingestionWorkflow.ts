import { createWorkflow } from '@mastra/core/workflows'
import { workflowInputSchema, embedOutputSchema } from './ingestionWorkflow.schemas.js'
import { detectFormatStep } from './ingestionWorkflow.detectFormat.js'
import { classifyStep } from './ingestionWorkflow.classify.js'
import { extractStep } from './ingestionWorkflow.extract.js'
import { validateStep } from './ingestionWorkflow.validate.js'
import { commitStep } from './ingestionWorkflow.commit.js'
import { embedStep } from './ingestionWorkflow.embed.js'

export const ingestionWorkflow = createWorkflow({
  id: 'document-ingestion',
  inputSchema: workflowInputSchema,
  outputSchema: embedOutputSchema,
})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(detectFormatStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(classifyStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(extractStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(validateStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(commitStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(embedStep as any)
  .commit()
