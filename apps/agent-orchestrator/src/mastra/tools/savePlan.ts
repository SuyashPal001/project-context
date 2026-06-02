import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { createPlanFromPrd } from '../../services/planService.js'

// PrdData shape — must match planService.PrdData exactly.
// tasks: [] on every milestone (Phase 3 fills them).
const milestoneSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  targetDate: z.string().optional(),
  tasks: z.array(z.any()).default([]),
})

const prdDataSchema = z.object({
  plan: z.object({
    title: z.string(),
    description: z.string(),
    targetDate: z.string().optional(),
  }),
  milestones: z.array(milestoneSchema),
  risks: z.array(z.string()),
  totalEstimatedHours: z.number().optional(),
})

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const savePlan = createTool({
  id: 'save-plan',
  description: 'Creates a project_plans record and project_milestones records from a PrdData object. Handles sequence_id via planService — do not reimplement.',
  requestContextSchema,
  inputSchema: z.object({
    prdData: prdDataSchema,
  }),
  outputSchema: z.object({
    planId: z.string(),
    sequenceId: z.number(),
    milestoneCount: z.number(),
  }),
  execute: async (inputData, execContext) => {
    const prdData = (inputData as any)?.prdData
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const userId   = execContext?.requestContext?.get('userId')   as string | undefined ?? ''
    const result = await createPlanFromPrd(tenantId, userId, prdData as any)
    // planSequenceId is returned as "PLN-{n}" — extract the number
    const sequenceId = parseInt(result.planSequenceId.replace('PLN-', ''), 10)
    return {
      planId: result.planId,
      sequenceId,
      milestoneCount: result.milestoneCount,
    }
  },
})
