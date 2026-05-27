import { createStep } from '@mastra/core/workflows';
import { db, pensionCases, pensionFindings } from '@serverless-saas/database';
import { eq } from 'drizzle-orm';
import { findingAssemblyOutputSchema, routeOutputSchema } from './pensionWorkflow.schemas.js';

export const routeToOfficerStep = createStep({
  id: 'pension-route-to-officer',
  inputSchema: findingAssemblyOutputSchema,
  outputSchema: routeOutputSchema,
  execute: async ({ inputData }) => {
    const assignedRole = 'Dealing Hand';

    // Persist findings
    const findingIds: string[] = [];
    for (const f of inputData.findings) {
      const [row] = await db.insert(pensionFindings).values({
        tenantId: inputData.tenantId,
        caseId: inputData.caseId,
        ruleId: f.ruleId,
        ruleName: f.ruleName,
        status: f.status,
        provision: f.provision,
        narration: f.narration,
        declaredValue: f.declaredValue != null ? String(f.declaredValue) : null,
        calculatedValue: f.calculatedValue != null ? String(f.calculatedValue) : null,
        math: f.math ?? null,
        trace: { ruleResults: inputData.ruleResults },
      }).returning({ id: pensionFindings.id });
      findingIds.push(row.id);
    }

    // Update case status
    await db.update(pensionCases)
      .set({ status: inputData.caseStatus, assignedRole, updatedAt: new Date() })
      .where(eq(pensionCases.id, inputData.caseId));

    return { ...inputData, assignedRole, findingIds };
  },
});
