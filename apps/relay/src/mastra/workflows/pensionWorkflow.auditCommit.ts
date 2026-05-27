import { createStep } from '@mastra/core/workflows';
import { routeOutputSchema, auditCommitOutputSchema } from './pensionWorkflow.schemas.js';

const LAKEHOUSE_URL = process.env.LAKEHOUSE_URL ?? 'http://localhost:8001';

export const auditCommitStep = createStep({
  id: 'pension-audit-commit',
  inputSchema: routeOutputSchema,
  outputSchema: auditCommitOutputSchema,
  execute: async ({ inputData }) => {
    // Best-effort: Postgres already has the truth; if lakehouse fails, workflow still succeeds.
    if (inputData.findings.length === 0) return { ...inputData, lakehouseVersion: -1 };
    try {
      const res = await fetch(`${LAKEHOUSE_URL}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: inputData.findings.map(f => ({
            pension_id: inputData.caseRef,
            rule_id: f.ruleId,
            status: f.status,
            provision: f.provision,
            declared: f.declaredValue,
            calculated: f.calculatedValue,
          })),
          label: `AI-PARAS finding — ${inputData.caseRef}`,
          description: 'Frozen agent finding for legal trail',
        }),
      });
      if (!res.ok) return { ...inputData, lakehouseVersion: -1 };
      const data = await res.json() as { version: number };
      return { ...inputData, lakehouseVersion: data.version };
    } catch {
      return { ...inputData, lakehouseVersion: -1 };
    }
  },
});
