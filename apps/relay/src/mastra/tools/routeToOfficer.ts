import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, pensionCases, pensionFindings } from '@serverless-saas/database'
import { eq } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// routeToOfficer — shared persist logic for AI-PARAS agent and the
// deterministic pensionWorkflow step. Both paths call this tool so the
// DB write is a single, auditable implementation.
// ---------------------------------------------------------------------------

export const routeToOfficerInputSchema = z.object({
  tenantId: z.string(),
  caseId: z.string(),
  caseStatus: z.enum(['pending_review', 'cleared', 'incomplete', 'reviewed', 'escalated']),
  findings: z.array(z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    status: z.enum(['pass', 'fail', 'cannot_evaluate']),
    provision: z.string(),
    narration: z.string(),
    declaredValue: z.number().nullable().optional(),
    calculatedValue: z.number().nullable().optional(),
    math: z.record(z.unknown()).nullable().optional(),
    sources: z.array(z.string()).optional(),
  })),
  ruleResults: z.array(z.unknown()).optional(),
})

export const routeToOfficerOutputSchema = z.object({
  assignedRole: z.string(),
  findingIds: z.array(z.string()),
  caseId: z.string(),
})

export async function routeToOfficer(
  input: z.infer<typeof routeToOfficerInputSchema>
): Promise<z.infer<typeof routeToOfficerOutputSchema>> {
  const assignedRole = 'Dealing Hand'

  const findingIds: string[] = []
  for (const f of input.findings) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [row] = await db.insert(pensionFindings).values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      ruleId: f.ruleId,
      ruleName: f.ruleName,
      status: f.status,
      provision: f.provision,
      narration: f.narration,
      declaredValue: f.declaredValue != null ? String(f.declaredValue) : null,
      calculatedValue: f.calculatedValue != null ? String(f.calculatedValue) : null,
      math: (f.math ?? null) as Record<string, unknown> | null,
      trace: { ruleResults: input.ruleResults ?? [] },
    }).returning({ id: pensionFindings.id })
    findingIds.push(row.id)
  }

  await db.update(pensionCases)
    .set({ status: input.caseStatus, assignedRole, updatedAt: new Date() })
    .where(eq(pensionCases.id, input.caseId))

  return { assignedRole, findingIds, caseId: input.caseId }
}

export const routeToOfficerTool = createTool({
  id: 'route_to_officer',
  description: 'Persists pension findings to the database and routes the case to the Dealing Hand officer queue. Call after validate_pension_case when findings are assembled.',
  inputSchema: routeToOfficerInputSchema,
  outputSchema: routeToOfficerOutputSchema,
  execute: async (inputData) => routeToOfficer(inputData),
})
