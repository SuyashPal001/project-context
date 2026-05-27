import { pgTable, uuid, text, jsonb, timestamp, numeric, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { users } from './auth';

export const pensionCaseStatusEnum = pgEnum('pension_case_status', [
  'pending_review', 'cleared', 'incomplete', 'reviewed', 'escalated',
]);

export const findingStatusEnum = pgEnum('finding_status', ['pass', 'fail', 'cannot_evaluate']);

export const officerActionEnum = pgEnum('officer_action', ['accept', 'override', 'escalate']);

// One pension case = one pensioner's set of documents, grouped explicitly.
export const pensionCases = pgTable('pension_cases', {
  id:            uuid('id').primaryKey().defaultRandom(),
  tenantId:      uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  caseRef:       text('case_ref').notNull(),          // e.g. "PPO/PB/2019/00847"
  pensionerName: text('pensioner_name').notNull(),
  officeCode:    text('office_code').notNull().default('PB-001'),
  documentIds:   jsonb('document_ids').notNull().default('[]'),  // string[] of documents.id
  fields:        jsonb('fields').notNull().default('{}'),        // extracted field map
  status:        pensionCaseStatusEnum('status').notNull().default('pending_review'),
  assignedRole:  text('assigned_role').notNull().default('Dealing Hand'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index('idx_pension_cases_tenant').on(t.tenantId),
}));

// One finding = one rule result for one case.
export const pensionFindings = pgTable('pension_findings', {
  id:              uuid('id').primaryKey().defaultRandom(),
  tenantId:        uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  caseId:          uuid('case_id').notNull().references(() => pensionCases.id, { onDelete: 'cascade' }),
  ruleId:          text('rule_id').notNull(),            // "R002"
  ruleName:        text('rule_name').notNull(),
  status:          findingStatusEnum('status').notNull(),
  provision:       text('provision').notNull(),          // "CCS Pension Rules 1972, Rule 49(1)"
  narration:       text('narration').notNull(),          // officer-readable text
  declaredValue:   numeric('declared_value'),
  calculatedValue: numeric('calculated_value'),
  math:            jsonb('math'),                         // { expression, inputs[] }
  trace:           jsonb('trace'),                        // full agent step trace
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseIdx: index('idx_pension_findings_case').on(t.caseId),
}));

// Human decision on a finding (or whole case).
export const pensionOfficerActions = pgTable('pension_officer_actions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tenantId:  uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  caseId:    uuid('case_id').notNull().references(() => pensionCases.id, { onDelete: 'cascade' }),
  findingId: uuid('finding_id').references(() => pensionFindings.id, { onDelete: 'cascade' }),
  action:    officerActionEnum('action').notNull(),
  rationale: text('rationale'),                          // required for override/escalate
  actorId:   uuid('actor_id').references(() => users.id),
  actorRole: text('actor_role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseIdx: index('idx_pension_actions_case').on(t.caseId),
}));
