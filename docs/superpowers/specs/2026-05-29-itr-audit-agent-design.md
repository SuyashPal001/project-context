# ITR & Assessment Order Audit Agent — Design Spec

**Status:** Approach approved, implementation on hold (ingestion pipeline dependency)
**Date:** 2026-05-29

---

## Scope

Second of 4 CAG audit agents. Audits ITR-1 documents by cross-referencing with Assessment Orders. Follows AI-PARAS pattern exactly.

**POC constraints:**
- ITR-1 only (salaried income, house property, interest)
- Rules: income discrepancy + Section 14A + Section 43B (Section 37 deferred)
- OCR: Gemini vision via existing inference gateway (same as pension ingestion)

---

## Architecture

```
itrAuditAgent (Tier 2)
  └── documentIntelligenceAgent (Tier 3, reused)
  └── itrWorkflow (6 steps)
        ├── completeness        — are ITR + AO both present in folder?
        ├── cross_reference     — build itrFields vs aoFields comparison map
        ├── rule_validate       — deterministic IT Act rule engine
        ├── finding_assembly    — structured observations with dual-source attribution
        ├── route_to_officer    — officer review queue
        └── audit_commit        — freeze to Delta Lake

Rule engine: apps/ai-service/rules/itr/it_act_rules.json
Schema:      packages/foundation/database/schema/itr.ts
Context:     itrContextSchema (extends tenantContextSchema + caseId + folderId)
```

**What's new vs AI-PARAS:**
- `cross_reference` step — builds `itr_vs_ao` comparison map before rule validation
- `it_act_rules.json` — 5 IT Act rules (R101–R105)
- `itr.ts` schema — `itr_cases`, `itr_findings`, `itr_officer_actions`

**What's reused unchanged:**
- `lookupPersonFolderTool`, `listFolderDocumentsTool`, `retrieveDocumentsTool`, `routeToOfficerTool`
- `lakehouseCommit`, rule engine evaluator (`ccsRules.ts` evaluator, different JSON)
- Inference gateway, RAG pipeline, Delta Lake

---

## Document Model

Single folder per case, folder identifier = `PAN-AY` (e.g. `XXXXX1234X-2024-25`).
Both ITR and AO uploaded to the same folder — same pattern as AI-PARAS.

The folder handles agent retrieval. No explicit agent↔document link needed.

---

## Extraction Timing

Fields are extracted at **ingestion time**, not workflow time — same as pension.

Two new entries needed in `geminiExtract.ts` `typeHints`:
```typescript
'ITR-1': 'Expected fields: pan, assessment_year, gross_total_income, exempt_income, total_deductions, taxable_income, tax_paid',
'Assessment Order': 'Expected fields: pan, assessment_year, assessed_income, additions_made, disallowance_14a, disallowance_43b, demand_raised, section',
```

`itr_cases` record is assembled after ingestion completes — reads `files.extractedFields` for both ITR and AO files, maps to `itrFields` / `aoFields`.

**No contention risk with pension ingestion** — Gemini Flash handles concurrent requests independently. ITR ingestion is a separate folder trigger with no shared queue.

---

## Schema (`packages/foundation/database/schema/itr.ts`)

```typescript
itr_cases {
  id, tenantId,
  caseRef,           // "XXXXX1234X-2024-25"
  pan,               // "XXXXX1234X"
  assessmentYear,    // "2024-25"
  taxpayerName,
  officeCode,
  documentIds,       // jsonb string[] — same pattern as pensionCases
  itrFields,         // jsonb — extracted ITR-1 fields
  aoFields,          // jsonb — extracted AO fields
  crossReference,    // jsonb — comparison map (itr.* vs ao.*)
  status,            // pending_review | cleared | incomplete | escalated
  assignedRole,
  createdAt, updatedAt
}

itr_findings {
  id, tenantId, caseId,
  ruleId, ruleName,
  status,            // pass | fail | cannot_evaluate
  provision,         // "Income Tax Act, Section 14A"
  narration,
  itrValue,          // declared (replaces declaredValue)
  aoValue,           // assessed (replaces calculatedValue)
  math,              // { expression, inputs[] }
  itrSource,         // { documentId, page, schedule, lineItem }
  aoSource,          // { documentId, page, paragraph }
  createdAt
}

itr_officer_actions {
  id, tenantId, caseId, findingId,
  action,            // accept | override | escalate
  rationale,
  actorId, actorRole,
  createdAt
}
```

---

## Workflow Steps (6 steps)

```
Step 1 — completeness
  Check both ITR and AO are present in folder
  If missing → status: incomplete, stop

Step 2 — cross_reference
  Read itrFields + aoFields from itr_cases record
  Build comparison map: itr.taxableIncome vs ao.assessedIncome,
                        itr.totalDeductions vs ao.allowedDeductions,
                        itr.exemptIncome vs ao.section10Allowed

Step 3 — rule_validate
  Run it_act_rules.json against crossReference map
  Same evaluator as ccsRules.ts — deterministic, no LLM decides pass/fail

Step 4 — finding_assembly
  LLM narrates each rule result
  Each finding: ruleId, status, provision, narration,
                itrValue, aoValue, itrSource, aoSource

Step 5 — route_to_officer
  Persist findings to itr_findings
  Route to officer queue (reuse routeToOfficerTool)

Step 6 — audit_commit
  Freeze to Delta Lake (reuse lakehouseCommit)
```

---

## Rule Engine (`apps/ai-service/rules/itr/it_act_rules.json`)

5 rules, same JSON format as `ccs_rules_1972.json`, same evaluator:

| Rule | Check | Provision |
|------|-------|-----------|
| R101 | `abs(itr_taxable_income - ao_assessed_income) < 10000` | ITA Section 143 |
| R102 | `itr_exempt_income <= ao_section10_allowed` | ITA Section 10 |
| R103 | `abs(ao_14a_disallowance - (total_expenses * exempt_income / gross_total_income)) < 5000` | ITA Section 14A |
| R104 | `itr_total_deductions <= ao_allowed_deductions` | ITA Section 80 |
| R105 | Flag if `ao_43b_disallowance > 0` | ITA Section 43B |

---

## Agent Tools (6 tools, mirrors AI-PARAS)

| Tool | Source |
|------|--------|
| `lookup_person_folder` | Reused — lookupPersonFolderTool |
| `list_folder_documents` | Reused — listFolderDocumentsTool |
| `retrieve_documents` | Reused — retrieveDocumentsTool |
| `check_required_documents` | New — checks for ITR + AO doc types |
| `validate_itr_case` | New — runs it_act_rules.json |
| `route_to_officer` | Reused — routeToOfficerTool |

---

## Files to Create

```
apps/relay/src/mastra/agents/itrAuditAgent.ts
apps/relay/src/mastra/workflows/itrWorkflow.ts
apps/relay/src/mastra/workflows/itrWorkflow.schemas.ts
apps/relay/src/mastra/workflows/itrWorkflow.completeness.ts
apps/relay/src/mastra/workflows/itrWorkflow.crossReference.ts
apps/relay/src/mastra/workflows/itrWorkflow.ruleValidation.ts
apps/relay/src/mastra/workflows/itrWorkflow.findingAssembly.ts
apps/relay/src/mastra/workflows/itrWorkflow.routeToOfficer.ts
apps/relay/src/mastra/workflows/itrWorkflow.auditCommit.ts
apps/relay/src/mastra/tools/validateItrCase.ts
apps/relay/src/mastra/tools/checkRequiredItrDocuments.ts
apps/relay/src/mastra/rules/itActRules.ts
apps/relay/src/routes/itr.ts
apps/ai-service/rules/itr/it_act_rules.json
packages/foundation/database/schema/itr.ts
apps/web/app/[tenant]/dashboard/itr-review/page.tsx
```

---

## Deferred

- Section 37 disallowance (requires LLM judgment, not deterministic)
- ITR-2 through ITR-7 support
- Cross-agent tagging to Supplementary Financial Audit Agent
- `geminiExtract` typeHints additions (touch ingestion only when ready)
