import { z } from 'zod'

// ─── Workflow input ───────────────────────────────────────────────────────────

export const workflowInputSchema = z.object({
  taskTitle: z.string(),
  taskDescription: z.string().optional(),
  attachmentContext: z.string(),
  tenantId: z.string(),
  autoApprove: z.boolean().optional(),
})

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const taskSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  estimatedHours: z.number().optional(),
  type: z.enum(['feature', 'bug', 'chore', 'spike']).default('feature'),
})

const milestoneSchema = z.object({
  title: z.string(),
  description: z.string(),
  targetDate: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  tasks: z.array(taskSchema),
})

// Core PRD extraction shape — reused as structuredOutput target and docDodVerify passthrough.
export const prdDataSchema = z.object({
  plan: z.object({
    title: z.string(),
    description: z.string(),
    targetDate: z.string().optional(),
  }),
  milestones: z.array(milestoneSchema),
  risks: z.array(z.string()),
  totalEstimatedHours: z.number().optional(),
})

// ─── Step output schemas ──────────────────────────────────────────────────────

export const planOutputSchema = z.object({
  plan: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
})

// extractStep output = prdData fields + token accumulators
export const extractOutputSchema = prdDataSchema.extend({
  inputTokens: z.number(),
  outputTokens: z.number(),
})

// docDodVerifyStep output = DoD result + prdData passthrough + token accumulators
export const docDodVerifyOutputSchema = z.object({
  passed: z.boolean(),
  failureReason: z.string().optional(),
  criteriaMet: z.array(z.string()),
  criteriaUnmet: z.array(z.string()),
  prdData: prdDataSchema,
  inputTokens: z.number(),
  outputTokens: z.number(),
})

// composeStep output — inputTokens/outputTokens are optional so formatterAgent can leave them
// null; we always override with exact values before returning. prdData is passed through so
// the calling route can use the structured data directly without re-parsing the summary.
export const composeOutputSchema = z.object({
  summary: z.string(),
  dodPassed: z.boolean(),
  prdData: prdDataSchema,
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
})
