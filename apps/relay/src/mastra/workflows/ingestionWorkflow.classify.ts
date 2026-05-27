import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { classifierAgent } from '../agents/classifierAgent.js'
import { workflowInputSchema, detectFormatOutputSchema, classifyOutputSchema } from './ingestionWorkflow.schemas.js'

export const classifyStep = createStep({
  id: 'ingestion-classify',
  inputSchema: detectFormatOutputSchema,
  outputSchema: classifyOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    console.log('[classifyStep] inputData keys:', inputData ? Object.keys(inputData) : 'undefined')
    const init = getInitData<z.infer<typeof workflowInputSchema>>()
    const filename = inputData?.filename ?? init.filename
    const formatDetected = inputData?.formatDetected ?? 'Unknown'
    const isScanned = inputData?.isScanned ?? false
    const extractedText = inputData?.extractedText ?? init.extractedText

    const prompt = `Filename: ${filename}
Format: ${formatDetected}
${extractedText ? `Text excerpt: ${extractedText.slice(0, 500)}` : '(scanned image — no text)'}

Classify this document.`

    console.log('[classifyStep] calling agent...')
    const result = await classifierAgent.generate(prompt, { activeTools: [] })
    console.log('[classifyStep] agent done')
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
      ...(inputData ?? { ...init, formatDetected, isScanned }),
      documentType,
      classificationConfidence: confidence,
      classificationReasoning: reasoning,
    }
  },
})
