import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { db, pensionCases, pensionFindings, pensionOfficerActions } from '@serverless-saas/database';
import { eq } from 'drizzle-orm';
import { findingAssemblyOutputSchema, routeOutputSchema } from './pensionWorkflow.schemas.js';

// ---------------------------------------------------------------------------
// routeToOfficerStep — Step 5 of the pension pre-scrutiny workflow.
//
// First pass:  persist findings to Postgres, set case to pending_review,
//              then SUSPEND for the officer decision (HITL gate).
//
// Resume pass: receive officer action (accept/override/escalate),
//              write to pension_officer_actions, update case status,
//              then pass through to Step 6 (auditCommit).
//
// The suspend/resume mechanism is the same as pmWorkflow.ts + routes/pm.ts.
// runId is tracked externally (relay routes/pension.ts in-memory map) so the
// officer UI can trigger the resume without a schema migration.
// ---------------------------------------------------------------------------

export const routeToOfficerStep = createStep({
  id: 'pension-route-to-officer',
  inputSchema: findingAssemblyOutputSchema,
  outputSchema: routeOutputSchema,

  resumeSchema: z.object({
    action: z.enum(['accept', 'override', 'escalate']),
    rationale: z.string().optional(),
    officerId: z.string().optional(),
    actorRole: z.string().optional(),
  }),

  suspendSchema: z.object({
    phase: z.literal('officer-review'),
    caseId: z.string(),
    assignedRole: z.string(),
    findingIds: z.array(z.string()),
    tenantId: z.string(),
  }),

  execute: async ({ inputData, resumeData, suspend, suspendData }) => {
    const assignedRole = 'Dealing Hand';

    // ── First pass: persist findings and suspend for officer decision ────────
    if (!suspendData?.caseId) {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          math: (f.math ?? null) as any,
          trace: { ruleResults: inputData.ruleResults },
        }).returning({ id: pensionFindings.id });
        findingIds.push(row.id);
      }

      // Set initial status — officer will change it on resume
      await db.update(pensionCases)
        .set({ status: inputData.caseStatus, assignedRole, updatedAt: new Date() })
        .where(eq(pensionCases.id, inputData.caseId));

      // HITL gate: suspend until officer acts (accept / override / escalate)
      return await suspend({
        phase: 'officer-review',
        caseId: inputData.caseId,
        assignedRole,
        findingIds,
        tenantId: inputData.tenantId,
      });
    }

    // ── Resume pass: officer decision received ───────────────────────────────
    const { action, rationale, officerId, actorRole } = resumeData!;

    const newStatus =
      action === 'accept'   ? 'cleared'    :
      action === 'escalate' ? 'escalated'  : 'reviewed';  // override → reviewed

    if (officerId) {
      await db.insert(pensionOfficerActions).values({
        tenantId: suspendData.tenantId,
        caseId: suspendData.caseId,
        action,
        rationale: rationale ?? '',
        actorId: officerId,
        actorRole: actorRole ?? suspendData.assignedRole,
        createdAt: new Date(),
      });
    }

    await db.update(pensionCases)
      .set({ status: newStatus as 'cleared' | 'escalated' | 'reviewed', updatedAt: new Date() })
      .where(eq(pensionCases.id, suspendData.caseId));

    return {
      ...inputData,
      assignedRole: suspendData.assignedRole,
      findingIds: suspendData.findingIds,
    };
  },
});
