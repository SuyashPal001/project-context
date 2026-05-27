import { createStep } from '@mastra/core/workflows'
import { classifierAgent } from '../agents/classifierAgent.js'
import { detectFormatOutputSchema, classifyOutputSchema } from './ingestionWorkflow.schemas.js'

export const classifyStep = createStep({
  id: 'ingestion-classify',
  inputSchema: detectFormatOutputSchema,
  outputSchema: classifyOutputSchema,
  execute: async ({ inputData }) => {
    const prompt = `Filename: ${inputData.filename}
Format: ${inputData.formatDetected}
${inputData.extractedText ? `Text excerpt: ${inputData.extractedText.slice(0, 500)}` : '(scanned image — no text)'}

Classify this document.`

    const result = await classifierAgent.generate(prompt, { activeTools: [] })
    const text = (result.text ?? '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)

    let documentType = 'Other'
    let confidence = 0.5
    let reasoning = 'Default classification (no agent response)'

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        documentType = parsed.documentType ?? 'Other'
        confidence = parsed.confidence ?? 0.5
        reasoning = parsed.reasoning ?? ''
      } catch {}
    }

    return {
      ...inputData,
      documentType,
      classificationConfidence: confidence,
      classificationReasoning: reasoning,
    }
  },
})
