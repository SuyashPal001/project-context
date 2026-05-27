import { z } from 'zod';

// Input: the case is already assembled in Postgres; the workflow receives its data.
export const pensionInputSchema = z.object({
  caseId: z.string(),
  tenantId: z.string(),
  caseRef: z.string(),
  pensionerName: z.string(),
  presentDocs: z.array(z.string()),
  // numeric fields for the rule engine
  fields: z.record(z.string(), z.number()),
  // per-field provenance for source attribution (key -> doc + page)
  fieldSources: z.record(z.string(), z.object({ sourceDoc: z.string(), sourcePage: z.number() })).default({}),
});

export const completenessOutputSchema = pensionInputSchema.extend({
  complete: z.boolean(),
  missingDocs: z.array(z.string()),
});

export const fieldValidationOutputSchema = completenessOutputSchema.extend({
  lowConfidenceFields: z.array(z.string()),
});

export const ruleResultSchema = z.object({
  ruleId: z.string(), ruleName: z.string(),
  status: z.enum(['pass', 'fail', 'cannot_evaluate']),
  provision: z.string(), inputs: z.array(z.string()),
  declared: z.number().nullable(), calculated: z.number().nullable(), message: z.string(),
});

export const ruleValidationOutputSchema = fieldValidationOutputSchema.extend({
  ruleResults: z.array(ruleResultSchema),
});

export const findingSchema = z.object({
  ruleId: z.string(), ruleName: z.string(), status: z.enum(['pass', 'fail', 'cannot_evaluate']),
  provision: z.string(), narration: z.string(),
  declaredValue: z.number().nullable(), calculatedValue: z.number().nullable(),
  math: z.object({
    expression: z.string(),
    inputs: z.array(z.object({ key: z.string(), value: z.number(), sourceDoc: z.string(), sourcePage: z.number() })),
  }).nullable(),
});

export const findingAssemblyOutputSchema = ruleValidationOutputSchema.extend({
  findings: z.array(findingSchema),
  caseStatus: z.enum(['pending_review', 'cleared', 'incomplete']),
});

export const routeOutputSchema = findingAssemblyOutputSchema.extend({
  assignedRole: z.string(),
  findingIds: z.array(z.string()),  // Postgres IDs after persist
});

export const auditCommitOutputSchema = routeOutputSchema.extend({
  lakehouseVersion: z.number(),
});
