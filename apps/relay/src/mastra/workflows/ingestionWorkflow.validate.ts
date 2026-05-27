import { createStep } from '@mastra/core/workflows'
import { validatorAgent } from '../agents/validatorAgent.js'
import { extractOutputSchema, validateOutputSchema } from './ingestionWorkflow.schemas.js'

export const validateStep = createStep({
  id: 'ingestion-validate',
  inputSchema: extractOutputSchema,
  outputSchema: validateOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.extractedFields.length === 0) {
      return {
        ...inputData,
        overallQuality: 'high' as const,
        needsReview: false,
        validationIssues: [],
      }
    }

    const prompt = `Document type: ${inputData.documentType}
Extracted fields:
${JSON.stringify(inputData.extractedFields, null, 2)}

Evaluate the extraction quality.`

    const result = await validatorAgent.generate(prompt, { activeTools: [] })
    const text = (result.text ?? '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)

    let overallQuality: 'high' | 'medium' | 'low' = 'medium'
    let needsReview = false
    let validationIssues: Array<{ field: string; issue: string }> = []

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        overallQuality = parsed.overallQuality ?? 'medium'
        needsReview = parsed.needsReview ?? false
        validationIssues = parsed.issues ?? []
      } catch {}
    }

    return {
      ...inputData,
      overallQuality,
      needsReview,
      validationIssues,
    }
  },
})
