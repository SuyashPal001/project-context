import { z } from 'zod'

// Shared request context schema for all tenant-scoped agents
// Add new fields here as needed — import in every agent
export const tenantContextSchema = z.object({
  tenantId: z.string().optional().default(''),
  agentId:  z.string().optional().default(''),
  userId:   z.string().optional().default(''),
})

// Extended context for pension agents — adds caseId and folderId so Studio shows the form fields
export const pensionContextSchema = tenantContextSchema.extend({
  caseId:   z.string().optional().default(''),
  folderId: z.string().optional().default(''),
})

export type TenantContext = z.infer<typeof tenantContextSchema>
export type PensionContext = z.infer<typeof pensionContextSchema>
