import { z } from 'zod'

export const workflowInputSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  bufferBase64: z.string(),
  extractedText: z.string().optional(),
  tenantId: z.string(),
  personalIdentifier: z.string().optional(),
  personFolderId: z.string().optional(),
})

export const detectFormatOutputSchema = workflowInputSchema.extend({
  formatDetected: z.string(),
  isScanned: z.boolean(),
})

export const classifyOutputSchema = detectFormatOutputSchema.extend({
  documentType: z.string(),
  classificationConfidence: z.number(),
  classificationReasoning: z.string(),
})

export const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  confidence: z.number(),
  page: z.number().optional(),
})

export const extractOutputSchema = classifyOutputSchema.extend({
  extractedFields: z.array(fieldSchema),
})

export const validateOutputSchema = extractOutputSchema.extend({
  overallQuality: z.enum(['high', 'medium', 'low']),
  needsReview: z.boolean(),
  validationIssues: z.array(z.object({ field: z.string(), issue: z.string() })),
})

export const commitOutputSchema = validateOutputSchema.extend({
  lakehouseVersion: z.number(),
  lakehouseLabel: z.string(),
})

export const embedOutputSchema = validateOutputSchema.extend({
  chunkCount: z.number(),
})
