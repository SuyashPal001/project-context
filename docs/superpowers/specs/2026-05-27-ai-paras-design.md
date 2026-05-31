# AI-PARAS — Pension Pre-Scrutiny Agent: Design Spec

> CAG EOI `CAG/AI-PLATFORM/EOI/05052026` — Agent Demo (45 marks: A1–A5)
> Date: 2026-05-27
> Status: Design approved, pending implementation plan
> Related: `DEMO-IMPLEMENTATION.md`, `GAP-TO-CLOSURE.md` (GAP 14)

---

## Purpose

AI-PARAS performs automated pre-scrutiny of government pension cases against CCS
(Pension) Rules 1972. It ingests a pensioner's documents, validates the case
against deterministic rules, produces findings with full source attribution and
shown calculations, and routes them to a human officer for accept / override /
escalate. **No AI decision is final — a human always owns the verdict.**

It is the platform's flagship agent demo, scored across five criteria:

| Criterion | Marks | What it measures |
|-----------|-------|------------------|
| A1 | 10 | End-to-end pipeline (document → finding → officer) |
| A2 | 15 | Accuracy of AI output |
| A3 | 10 | Explainability + source attribution |
| A4 | 8  | Human-in-the-loop controls |
| A5 | 2  | Platform-native operation |

---

## Design Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| Demo flow | How findings are shown | **Pre-processed batch + one live run.** Batch (5 cases) processed night before; one case (Harbhajan Singh) run live to prove authenticity. |
| Case mix | What the batch demonstrates | **2 clean + 3 violations.** Proves the agent has judgment — it clears good cases, not just a tripwire. |
| Officer controls | Human-in-the-loop actions | **Accept / Override / Escalate to SAO.** Maps CAG's real Dealing Hand → SAO hierarchy. Override + Escalate require rationale. |
| Explainability | Depth of reasoning shown | **Math shown by default (B), full agent trace on expand (C).** Every input value links to its source document + page. |
| Narrative | Demo cohesion | **Harbhajan Singh case is the climax** of the same thread shown in P1–P6. Workflow is case-agnostic; this case is the chosen demo thread, not hardcoded. |
| Storage | Where findings persist | **Postgres + Iceberg, built Postgres-first.** Postgres powers the officer UI; Iceberg freezes the original finding for the legal trail. Build & test Postgres path first, then layer Iceberg. |
| Case grouping | What a "pension case" is | **Explicit `pension_cases` table** linking case_id → document_ids. Demo-safe; no dependency on OCR extracting IDs perfectly. |

---

## Architecture

Mastra is the backbone — same pattern as the ingestion workflow. Mastra provides
the engine (workflow orchestration, step I/O, tool-calling, agent runtime, LLM
routing); we supply the pension domain content (steps, rules, prompts, UI).

```
Documents (P1 ingest) → Case assembly (pension_cases) → AI-PARAS workflow
   → findings → Postgres queue + Iceberg freeze → Officer Review UI
```

### The 6-step workflow

Mirrors `ingestionWorkflow.ts`: composition root + `.schemas.ts` + one file per step.
Case-agnostic — takes a `case_id`, runs any case.

```
pensionWorkflow.ts                   composition root (.then chain)
pensionWorkflow.schemas.ts           Zod schemas for step I/O
pensionWorkflow.completeness.ts      Step 1
pensionWorkflow.fieldValidation.ts   Step 2
pensionWorkflow.ruleValidation.ts    Step 3
pensionWorkflow.findingAssembly.ts   Step 4
pensionWorkflow.routeToOfficer.ts    Step 5
pensionWorkflow.auditCommit.ts       Step 6
```

| Step | Name | Does | LLM? |
|------|------|------|------|
| 1 | `completeness_check` | `check_required_documents` tool — Service Book, PPO, salary cert present? | No |
| 2 | `field_validation` | Validate extracted fields; flag low OCR-confidence values | No |
| 3 | `rule_validation` | `validate_pension_case` tool — runs CCS rules JSON, deterministic pass/fail | **No** |
| 4 | `finding_assembly` | Structure findings (rule + math + source); LLM narrates into officer-readable prose | **Yes** (narration only) |
| 5 | `route_to_officer` | Write to officer queue with Dealing Hand → SAO routing | No |
| 6 | `audit_commit` | Freeze findings + run trace to `audit_findings` (Iceberg) for legal trail | No |

**Determinism principle:** the *judgment* (Steps 1–3) is rule-based and reproducible
— an auditor can re-run and get an identical result. The LLM is used only for
narration (Step 4) and upstream extraction. The LLM never decides pass/fail.

### CCS Rules Config (the rule engine)

Deterministic JSON, inspectable and editable without code changes.

```
apps/ai-service/rules/pension/ccs_rules_1972.json     core rules
apps/ai-service/rules/pension/state_adaptations/       per-state overrides
```

Each rule is self-describing:

```json
{
  "id": "R002",
  "name": "Pension calculation",
  "check": "abs(declared_pension - (last_pay * qualifying_service / 66)) < 100",
  "error": "Pension mismatch. Declared: ₹{declared_pension}, Calculated: ₹{calculated}",
  "provision": "CCS Pension Rules 1972, Rule 49(1)",
  "inputs": ["declared_pension", "last_pay", "qualifying_service"]
}
```

Rule set (extendable):

| Rule | Checks | Provision |
|------|--------|-----------|
| R001 | Min 10 years qualifying service | Rule 49 |
| R002 | Pension = Last Pay × Service / 66 | Rule 49(1) |
| R003 | Commutation ≤ 40% of pension | Rule 10 |
| R004 | DCRG formula correct | Rule 50 |
| R005 | Family pension eligibility | Rule 54 |

The `provision` field feeds the A3 citation. The `inputs` array tells the UI which
source fields to display and link back to their document/page (the "show the math" view).

### Case assembly

A pension case is an explicit `pension_cases` row linking `case_id` → `document_ids`.
Created by the seed script (demo) or an officer (production). No reliance on OCR
extracting matching IDs across documents.

### Storage

| Store | Role | Build order |
|-------|------|-------------|
| Postgres | Officer queue + UI reads/writes; Accept/Override/Escalate update here | **First** — prove end-to-end, test fully |
| Iceberg (`audit_findings`) | Frozen copy of the finding the moment the agent produces it — the untouched legal record | **Second** — additive; if it fails, Postgres path still demos |

Completes the P3 lineage chain: raw doc → extract → chunk → **finding**.

---

## Officer Review UI

Next.js in `apps/web`, reading from Postgres. The A4 + A3 surface.

```
apps/web/app/[tenant]/dashboard/pension-review/page.tsx           queue
apps/web/app/[tenant]/dashboard/pension-review/[caseId]/page.tsx  detail + actions
```

**1. Case queue** — list of cases with verdict (cleared ✅ / pending ⚠), finding
count, assignee. Shows the 2-clean + 3-violation range.

**2. Case detail** — per finding: declared vs calculated, the math with each input
linked to its source page, the CCS provision cited, action buttons, and a
"Show full agent trace" expander (C).

```
FINDING 1 — Rule 49(1) · Pension Calculation        [⚠ Fail]
  Declared pension:    ₹23,400
  Calculated pension:  ₹27,180
  ▸ The math:  Last Pay ₹54,360 × Qualifying Service 33 / 66 = ₹27,180
                 └ Last Pay      → Service Book, p.4
                 └ Qual. Service → Service Book, p.2
  Provision: CCS Pension Rules 1972, Rule 49(1)
  [ Accept ]  [ Override ]  [ Escalate to SAO ]
  ▸ Show full agent trace
```

**3. Action modal** — Accept (logged) / Override (rationale required, logged) /
Escalate to SAO (reassign, optional note, logged). Every action writes to the
existing tamper-evident audit log (P4), making the human decision trail auditable.

---

## Seed Data

Loaded the night before. Believable Punjab pension data with deliberate, plausible errors.

| # | Pensioner | Case ID | Verdict | Finding |
|---|-----------|---------|---------|---------|
| 1 | Sh. Harbhajan Singh (Naib Tehsildar) | PPO/PB/2019/00847 | ⚠ | R002 — pension mismatch ₹23,400 vs ₹27,180 (climax thread) |
| 2 | Smt. Kulwinder Kaur (Clerk Gr-I) | PPO/PB/2021/01134 | ✅ | clean |
| 3 | Sh. Gurpreet Singh (Asst. Engineer) | PPO/PB/2020/00512 | ⚠ | R003 — commutation 47% > 40% |
| 4 | Sh. Mohan Lal (Peon) | PPO/PB/2022/00298 | ⚠ | R001 — 8 yrs service < 10 min |
| 5 | Smt. Rajwinder Kaur (Steno) | PPO/PB/2021/00876 | ✅ | clean |

Harbhajan Singh carries the same ₹23,400 → ₹27,180 numbers as the P2 time-travel
demo — the agent's R002 finding *is* that discrepancy, closing the loop.

```
scripts/generate_pension_corpus.py   generates 5 cases + documents + fields (config-driven)
scripts/seed_pension_cases.py        loads pension_cases + links into Postgres
```

Corpus generator is config-driven — swap pensioners or add cases without code changes.

---

## Error Handling

### Agent-level (correctness)

| Situation | Behavior |
|-----------|----------|
| Required document missing (Step 1) | Status → "Incomplete — awaiting documents". Listed with reason, no crash. |
| OCR field low confidence (Step 2) | Field flagged ⚠; rules still run, input marked "verify". Honest, not hidden. |
| Rule input missing | Rule returns "cannot evaluate — missing input", not a false pass/fail. |
| LLM narration fails (Step 4) | Fall back to raw `error` template from rule JSON. Finding still shows. |
| Iceberg commit fails (Step 6) | Postgres already succeeded → queue works. Iceberg freeze retries async. |

### Demo-day safety

| Risk | Prevention |
|------|------------|
| Ollama cold start on live run | Warm up with dummy case 5 min before demo |
| Live run stumbles | 5-case batch already on screen — never empty-handed |
| Findings queue empty | Batch seeded + run night before; verified before evaluator arrives |
| Numbers don't match P2 story | Harbhajan Singh values pinned in seed config; cross-checked vs lakehouse reset |

---

## Demo Script (~10 min)

```
T+00:00  Open Pension Review queue — 5 cases visible
         "These were processed overnight by AI-PARAS."
T+01:00  Verdicts: 2 cleared, 3 flagged. "It has judgment — not flagging everything." (A2)
T+02:00  Open Gurpreet Singh — R003 commutation 47%. Show math + source pages. (A3)
T+03:30  Open Mohan Lal — R001 short service. Different rule → proves range. (A2)
T+05:00  "Now watch it run live." Trigger Harbhajan Singh fresh.
T+06:30  Steps stream: completeness → fields → rules → finding.
T+07:30  Finding: R002, ₹23,400 vs ₹27,180. "Same case you saw ingested and corrected earlier." (payoff)
T+08:30  Officer clicks Override → rationale → Escalate to SAO. (A4)
T+09:30  "Every step is in the immutable audit trail." (A3 + P2/P4 tie-in)
T+10:00  Hand to evaluator.
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `apps/relay/src/mastra/workflows/pensionWorkflow.ts` | Composition root |
| `apps/relay/src/mastra/workflows/pensionWorkflow.schemas.ts` | Step I/O schemas |
| `apps/relay/src/mastra/workflows/pensionWorkflow.{completeness,fieldValidation,ruleValidation,findingAssembly,routeToOfficer,auditCommit}.ts` | 6 steps |
| `apps/relay/src/mastra/tools/checkRequiredDocuments.ts` | Step 1 tool |
| `apps/relay/src/mastra/tools/validatePensionCase.ts` | Step 3 tool (loads CCS JSON) |
| `apps/ai-service/rules/pension/ccs_rules_1972.json` | CCS rule set |
| `packages/foundation/database/schema/pension.ts` | `pension_cases`, findings tables |
| `apps/web/app/[tenant]/dashboard/pension-review/page.tsx` | Officer queue |
| `apps/web/app/[tenant]/dashboard/pension-review/[caseId]/page.tsx` | Case detail + actions |
| `scripts/generate_pension_corpus.py` | Synthetic 5-case generator |
| `scripts/seed_pension_cases.py` | Postgres seeder |

---

## Scoring Map

| Criterion | How this design earns it |
|-----------|--------------------------|
| A1 (10) | Document → case assembly → 6-step workflow → finding → officer queue, end-to-end |
| A2 (15) | 2-clean + 3-violation batch proves accuracy + judgment; deterministic rules ensure correctness |
| A3 (10) | Math shown with per-input source-page links; CCS provision cited; full trace on expand; Iceberg freeze |
| A4 (8)  | Accept / Override / Escalate with rationale + SAO hierarchy; every action in tamper-evident audit log |
| A5 (2)  | Built entirely on platform Mastra + RAG + Iceberg + self-hosted LLM — no independent stack |
