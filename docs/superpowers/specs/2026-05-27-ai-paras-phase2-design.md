# AI-PARAS Phase 2 — Closing the 45-Mark Gaps: Design Spec

> CAG EOI `CAG/AI-PLATFORM/EOI/05052026` — Agent Demo (45 marks: A1–A5)
> Date: 2026-05-27
> Status: Design proposed, pending approval
> Builds on: `2026-05-27-ai-paras-design.md` (Phase 1, implemented & on `develop`)
> Related: `GAP-TO-CLOSURE.md` GAP 9 (page numbers), GAP 14 (AI-PARAS)

---

## Why this spec exists

Phase 1 built AI-PARAS end-to-end on Mastra and it works: 6-step workflow, deterministic CCS
rules, officer review UI with accept/override/escalate, audit logging. **A2, A4, A5 are
genuinely complete.** But validating against the 45 marks surfaced three gaps where the demo
currently relies on **hand-seeded data** instead of real automation:

| Gap | Criterion | Current state | Risk |
|-----|-----------|---------------|------|
| G1 | **A1 (10) — end-to-end pipeline** | Pension case fields (`last_pay`, `qualifying_service_years`, …) are **seeded by a script**. The agent never reads them off a document. | If the evaluator hands over a fresh document and asks "make it a finding," the document→fields step is missing. |
| G2 | **A3 (10) — source attribution** | "Service Book, p.4" links come from **seeded** `field_sources`. Ingestion does not track page numbers (GAP 9). | Attribution is real-looking but not actually traced from the document on the live path. |
| G3 | **A4 (8) — human-in-the-loop** | Escalate-to-SAO flips case status to `escalated`, but there is **no SAO view** and no seeded SAO officer to receive it. | The escalation has no visible destination — the loop looks half-closed. |

This spec closes all three. The unifying insight: **the LLM should be doing the extraction**
(messy Service Book → structured `{last_pay: 54360, page: 4}`), while deterministic rules do
the validation. Phase 1 hand-fed the extraction; that is the one place the agent should
genuinely reason. Fixing it is what makes A1 real *and* uses Mastra properly.

---

## Core architectural decision: AI-PARAS becomes a real Mastra Agent

Phase 1 built AI-PARAS as a rigid **workflow** (`.then()` chain) — the LLM did almost nothing,
so it read as an automated pipeline, not an agent. Phase 2 rebuilds it as a genuine Mastra
**Agent**: an LLM with a system prompt and tools, that **reasons about a pension case and
decides which tools to call**. This is what makes it "an agent platform," and it uses Mastra
the way the existing `pmAgent` / `architectAgent` / `classifierAgent` already do.

**The reconciliation that keeps it defensible:** the agent *orchestrates*, but the **verdict
tool (`validate_pension_case`) stays deterministic inside.** The LLM decides the flow (gather,
extract, validate, narrate, escalate) and does the fuzzy work (reading messy OCR into numbers,
phrasing findings, deciding to escalate) — but it **never computes pass/fail**. The rule engine
does that, identically every time. An auditor can still defend "Rule 49(1) → ₹27,180"; the AI
drove the process, it didn't invent the math.

**Demo safety:** the deterministic Phase 1 workflow is **kept as a fallback path** for the
pre-seeded batch. The live "fresh document" moment uses the agent; if it ever stumbles, the
seeded batch (run via the deterministic workflow) is already on screen. Best of both.

## Design decisions

| # | Decision | Choice |
|---|----------|--------|
| Primary architecture | Agent vs workflow | **Mastra `Agent`** (`aiParasAgent`) is the primary, demo path — LLM + tools, reasoning-driven. |
| Demo safety net | What if the live agent stumbles | **Keep the Phase 1 deterministic workflow** for the pre-seeded batch. Agent for the live run; workflow for the always-on-screen batch. |
| Verdict integrity | Who decides pass/fail | **`validate_pension_case` stays deterministic.** The agent calls it; the rule engine computes the verdict. LLM never decides pass/fail. |
| Extraction owner | Who turns a document into pension fields | **The agent** — via an `extract_pension_fields` tool (LLM reads the document's text/OCR into the structured numeric field set with `{doc, page}` provenance). This is the legitimate place for AI reasoning. Deterministic key-map fallback if LLM unavailable. |
| Case grouping | How docs become one case | Agent groups documents by **extracted PPO number** (`ppo_number`); falls back to officer-assigned grouping if absent. |
| Page numbers | A3 real attribution | Add **page tracking to the ingestion extract step** (closes GAP 9), so extraction records which page each value came from. |
| SAO loop | A4 receiving end | **Role filter on the existing pension-review queue** (no new page) + a seeded SAO officer. Escalated cases appear in the SAO's view. |
| Backwards compat | Don't break Phase 1 | Seed scripts and the workflow both stay. The agent path is additive. |

---

## Architecture — a three-tier agent network

The headline is **multi-agent delegation**. The platform supervisor routes a pension case to a
domain specialist, which in turn delegates document-reading to its own specialist. Each tier is
a real Mastra `Agent` with one clear job.

```
Document uploaded (P1 ingestion — already built)
   → ingestion extract step now ALSO records page number per field        [G2]
        ↓
TIER 1 — Saarthi  (platformAgent, EXISTS)
   Platform supervisor. Governance (PromptInjectionDetector, Moderation),
   PII redaction on output, SOVEREIGN MODEL ROUTING (restricted data →
   on-prem model), MCP tools, memory.
   Recognises a pension case → delegates to AI-PARAS.   (agents: { aiParasAgent })
        ↓ delegates
TIER 2 — AI-PARAS  (aiParasAgent, NEW)  ── pension pre-scrutiny lead
   Instructions: "You are AI-PARAS, a CAG pension pre-scrutiny auditor.
   Ensure required documents are present, obtain the pension fields,
   validate against CCS rules, assemble cited findings, route to the
   officer. NEVER decide pass/fail yourself — always use validate_pension_case."
   Reasons + calls:
     • check_required_documents   (tool, deterministic)          [completeness]
     • DocumentIntelligenceAgent  (SUB-AGENT) → extract fields    [G1, G2]
     • validate_pension_case      (tool, DETERMINISTIC verdict)   [A2 integrity]
     • route_to_officer           (tool, persist + assign)        [A4]
   Memory, structured-output findings, finding scorers.
        ↓ delegates extraction
TIER 3 — DocumentIntelligenceAgent  (NEW)  ── document reader
   Reads Service Book / PPO text+OCR → structured pension field set
   (last_pay, qualifying_service_years, declared_pension,
   commutation_amount, declared_dcrg), each with { sourceDoc, sourcePage }.
   Genuine LLM reasoning. Deterministic key-map fallback if LLM down.
        ↓
Findings → Postgres queue (Phase 1 schema) → Officer review UI
        ↓
Officer review UI (Phase 1) + SAO role filter (NEW)                        [G3]

HUMAN-IN-THE-LOOP: the run can suspend at the officer decision and resume
on accept/override/escalate (Mastra suspend/resume — VERIFY API in v1.32.1). [A4]

FALLBACK (demo safety): the Phase 1 deterministic pensionWorkflow runs the
pre-seeded batch, so cleared/flagged cases are always on screen even if the
live agent network stumbles.
```

### The tiers as Mastra agents

All three follow the project's established patterns — nothing invented:

- **Tier 1 — Saarthi (`platformAgent`, exists):** gains AI-PARAS in its `agents: {}` map (the
  `pmAgent` delegation pattern). Already has governance processors + sovereign model routing +
  memory. The case enters here; Saarthi delegates pension work to AI-PARAS.

- **Tier 2 — AI-PARAS (`aiParasAgent`, new):** `new Agent({ name, instructions, model, tools,
  agents, memory })`. Tools: `check_required_documents` + `validate_pension_case` (reused from
  Phase 1, unchanged) and `route_to_officer` (new, wraps the Phase 1 persist so the fallback
  workflow and the agent share one implementation — DRY). Sub-agent: `DocumentIntelligenceAgent`.
  Carries memory, structured-output findings, and finding scorers.

- **Tier 3 — DocumentIntelligenceAgent (`documentIntelligenceAgent`, new):** `new Agent(...)`
  whose job is document → fields with page provenance. The genuine extraction reasoning (G1/G2).
  Deterministic key-map fallback (`pension_amount`→`declared_pension`, …) if the LLM is down.

**Net result:** upload a document → Saarthi routes it → AI-PARAS scrutinises it → a cited finding
appears, no manual field entry. That is A1, genuinely end-to-end, genuinely agentic, and visibly
multi-agent.

**Why three tiers and not more:** each tier earns its place (supervision/governance; pension
orchestration; document reading). The deterministic verdict stays a *tool*, not an agent — we do
not spin up an agent for math that must be reproducible. That restraint is the design maturity.

### The deterministic scrutiny is a self-contained workflow the agent uses

AI-PARAS does not hand-roll the deterministic steps. The Phase 1 `pensionWorkflow`
(completeness → validate → assemble findings → route) is repackaged as a **self-contained
workflow exposed to the agent** via `workflows: { scrutiny: pensionScrutinyWorkflow }` — the
exact pattern `roadmapAgent`/`taskAgent`/`prdAgent` already use. The agent invokes it as one
reproducible capability after the sub-agent has extracted the fields. The *same* workflow runs
standalone for the pre-seeded batch (the fallback). **One workflow, two callers — DRY, and it
demonstrates agent + workflow composition,** a Mastra-specific strength.

### Human-in-the-loop via suspend/resume (proven pattern)

The scrutiny workflow **suspends** at the officer-decision point and **resumes** on
accept/override/escalate — using the same `suspend()` / `resumeData` / `run.resume({...})`
mechanism already in `pmWorkflow.ts` + `routes/pm.ts`. This is real orchestration: the run
genuinely pauses awaiting a human and continues with their decision — not a status flag. It is
the strongest possible form of A4 (human-in-the-loop control), and most competing frameworks
cannot pause and resume an agent run at all.

---

## Capabilities AI-PARAS showcases (the highlight reel)

AI-PARAS is the one agent that exercises the platform's entire Mastra surface. For the demo,
each capability is a named moment the evaluator sees — and each is already proven in this
codebase, so we are assembling, not inventing.

| # | Capability | Demo moment | Proven in | Competitor gap |
|---|-----------|-------------|-----------|----------------|
| 1 | **Multi-agent delegation** | Saarthi routes the case to AI-PARAS, which delegates reading to DocumentIntelligenceAgent | `pmAgent`, `roadmapAgent` | Most demos are a single bot |
| 2 | **Agent + self-contained workflow composition** | AI-PARAS invokes the deterministic `scrutiny` workflow as one capability | `prdAgent.workflows` | Agent OR workflow, rarely composed |
| 3 | **Human-in-the-loop suspend/resume** | Run pauses for the officer; resumes on accept/override/escalate | `pmWorkflow` + `routes/pm.ts` | Most frameworks can't suspend/resume a run |
| 4 | **Sovereign model routing by data class** | Restricted pension data → on-prem model automatically | `platformAgent.model(...)` | API-only stacks can't route per-request to sovereign infra |
| 5 | **Governance processors** | Prompt-injection defence on the document; PII redaction on the finding | `platformAgent` processors | Rarely built-in |
| 6 | **Memory + semantic recall** | Agent recalls the case + related rules on a follow-up | `architectAgent`, `pmAgent` | Stateless bots can't |
| 7 | **Live scorers / evals** | Each finding scored (citation-grounding, faithfulness); shows on the P8 dashboard | `scorers.ts` registered | Eval-in-the-loop is rare |
| 8 | **Structured output** | Findings emitted in an exact schema, never free-text | `formatterAgent` | Brittle elsewhere |
| 9 | **Deterministic verdict inside an agent** | Defensible math, agentic orchestration | Phase 1 rule engine | Most go all-LLM (indefensible) or all-rules (not agentic) |
| 10 | **Streaming reasoning + tool trace** | The evaluator watches it think and call tools live | `chatStream.ts` | — |

### What the evaluator actually sees (this is an agent, not a flow)

The demo must read as a real agent platform — never a flow diagram. Concretely:

- **A persona + live reasoning.** AI-PARAS streams its thinking and tool calls in real time
  (via the existing `.stream()` path used in `chatStream.ts`): "Checking required documents…
  all present. Extracting fields from the Service Book… last pay ₹54,360 on p.4. Validating
  against CCS rules… Rule 49(1) mismatch — declared ₹23,400 vs calculated ₹27,180. Routing to
  the Dealing Hand." The evaluator watches it work.
- **Real tool calls.** The streamed trace shows actual tool invocations
  (`check_required_documents`, `extract_pension_fields`, `validate_pension_case`,
  `route_to_officer`) with their inputs/outputs — provable, not narrated theatre.
- **Memory.** The agent uses `getMastraMemory()` (Postgres-backed working memory + vector
  recall), exactly like `architectAgent`/`pmAgent` already do. It holds case context across
  the interaction and can recall relevant prior cases/rules. Shown if the evaluator asks a
  follow-up — the agent remembers the case it just scrutinised.
- **The deterministic workflow is invisible.** It runs only the pre-seeded batch silently, as a
  safety net. It is never presented to the evaluator as the agent. There is no `.then()` chain
  on screen.

This is the difference between "here is a pipeline" and "here is an auditor that reasons." The
agent paradigm is the demo; the workflow is the insurance.

### Full Mastra capability set (each maps to a CAG mark)

AI-PARAS uses the complete Mastra agent feature set — every one already proven in this codebase,
and every one earns a scoring criterion. This is what makes it visibly "an agent platform."

**Flagship framing (a demo asset):** these capabilities exist across the project today, but
*no single agent uses all of them* — memory is in `architectAgent`/`platformAgent`/`pmAgent`,
tools in five agents, processors only in `platformAgent`, structured output in `formatterAgent`,
scorers registered separately. **AI-PARAS is the first agent to combine the full set** — the
showcase that demonstrates the platform's entire capability surface in one agent. We are not
inventing anything; we are assembling proven pieces into the flagship.

| Mastra capability | What AI-PARAS uses it for | Codebase precedent | Scores |
|-------------------|---------------------------|--------------------|--------|
| **Tools** | `check_required_documents`, `extract_pension_fields`, `validate_pension_case`, `route_to_officer` — the agent's actions | all tool-using agents | A1, A2 |
| **Memory** | `getMastraMemory()` — Postgres working memory + vector recall; holds case context, recalls prior cases/rules on follow-up | `architectAgent`, `pmAgent`, `platformAgent` | A1, A4 |
| **Structured output** | Force the finding into the exact schema (`ruleId, status, declared, calculated, provision, narration, math, sources`) — reliable, never free-text guesswork | `formatterAgent` | A3 |
| **Input processors** | `PromptInjectionDetector` on document content — defends against a poisoned/adversarial document trying to manipulate the auditor. Strong governance story. | `platformAgent.inputProcessors` | P4/P7 governance |
| **Output processors** | `PIIDetector` + `SystemPromptScrubber` on findings — flags/redacts sensitive personal data leaving the agent. Directly supports the sovereignty + data-protection narrative. | `platformAgent.outputProcessors` | P4/P7 governance |
| **Scorers** | `createScorer` evaluating each finding — e.g. *citation-grounding* (does the finding cite a real rule + real source field?) and *faithfulness* (does the narration match the deterministic verdict?). Scores register on the Mastra instance and surface in the observability dashboard. | `scorers.ts` (`dodPassScorer`) registered in `mastra/index.ts` | A2, A3, P8, GAP 7 |
| **Streaming** | Live reasoning + tool-call trace shown to the evaluator | `chatStream.ts` | the demo itself |

The "skill" of the agent is its **instructions** (system prompt) — the CAG-auditor persona and
the rule that it must always defer pass/fail to `validate_pension_case`. (Mastra has no separate
"skill" primitive; instructions + tools are the agent's skill set.)

**Scorers close GAP 7 too:** wiring finding-quality scorers means the observability dashboard
(P8) shows live agent-quality metrics during the demo — turning an open gap into a strength.

### Why the verdict tool stays deterministic (not the agent's job)

`validate_pension_case` wraps the rule engine. Same inputs → same results, every run. The agent
chooses *to* validate and interprets the results into findings, but the pass/fail and the
calculated numbers come from code, not the model. This keeps every finding reproducible and
defensible — which scores A2 (accuracy) and A3 (explainability) higher than an LLM "judgment"
ever could, while the orchestration around it is fully agentic.

### G2 — page numbers in ingestion (GAP 9)

The ingestion `extract` step currently emits `{ key, label, value, confidence }`. Add an
optional `page` to that field schema, and populate it during PDF/scanned extraction (the page
the value was found on). This is the one change to an existing, working file — kept minimal
and backward-compatible (field stays optional; existing rows unaffected).

### G3 — SAO receiving end

No new page. The existing pension-review queue gains a **role/status filter**. Seed a second
officer with role `SAO`. When a Dealing Hand escalates, the case status becomes `escalated`
and `assignedRole` becomes `SAO`; the SAO's filtered queue view shows it. Demonstrates the
full hierarchy (Dealing Hand → SAO) with a real receiving end — strengthens A4.

---

## What this earns

| Criterion | Before | After |
|-----------|--------|-------|
| A1 (10) | Findings from seeded numbers | **Document → extracted fields → finding, automated.** Live "fresh document" demo works. |
| A3 (10) | Seeded "p.4" links | **Page numbers traced from the actual document** during ingestion. |
| A4 (8) | Escalation flips a status | **SAO receives the escalated case** in their queue — loop visibly closed. |

A2 (15) and A5 (2) already complete in Phase 1 — unchanged.

## Scope guards (YAGNI)

- **Not** rebuilding extraction — ingestion already extracts; we add page tracking + a mapping step.
- **Not** removing the seed scripts — pre-seeding stays for the controlled batch; automation is for the live moment.
- **Not** a new UI page for SAO — a filter on the existing queue.
- **Not** making the rules LLM-driven — verdicts stay deterministic (defensibility).

---

## Files (anticipated)

| File | Responsibility |
|------|----------------|
| `apps/relay/src/mastra/agents/aiParasAgent.ts` | **Tier 2 — pension lead.** instructions, model, tools, sub-agent, memory, structured output |
| `apps/relay/src/mastra/agents/documentIntelligenceAgent.ts` | **Tier 3 — document reader.** Extracts fields + page provenance |
| `apps/relay/src/mastra/agents/platformAgent.ts` | **Tier 1 — Saarthi.** Add `aiParasAgent` to its `agents: {}` delegation map |
| `apps/relay/src/mastra/tools/routeToOfficer.ts` | Shared persist tool (findings + case status) — used by the agent AND the Phase 1 workflow fallback (DRY) |
| `apps/relay/src/mastra/scorers/pensionScorers.ts` | `createScorer` — citation-grounding + faithfulness scorers for findings |
| `apps/relay/src/mastra/index.ts` | Register both new agents + pension scorers on the Mastra instance |
| `apps/relay/src/mastra/workflows/ingestionWorkflow.schemas.ts` | Add optional `page` to `fieldSchema` (GAP 9) |
| `apps/relay/src/mastra/workflows/ingestionWorkflow.extract.ts` | Populate `page` per field |
| `apps/relay/src/routes/pension.ts` | Route to run the agent network on a document/case + stream the reasoning; suspend/resume hook for officer decision |
| `apps/web/app/[tenant]/dashboard/pension-review/page.tsx` | Add role/status filter (SAO view) |
| `scripts/seed_pension_cases.py` | Add a seeded SAO officer/role |

Reused unchanged from Phase 1: `check_required_documents`, `validate_pension_case` tools; the
CCS rule engine; the `pension_cases`/`pension_findings`/`pension_officer_actions` schema; the
deterministic `pensionWorkflow` (now the fallback path).

Reused unchanged from Phase 1: `check_required_documents`, `validate_pension_case` tools; the
CCS rule engine; the `pension_cases`/`pension_findings`/`pension_officer_actions` schema; the
deterministic `pensionWorkflow` (now the fallback path).

---

## Open items to confirm during planning

- Exact keys the ingestion `extract` step currently emits for pension docs (to write the
  deterministic fallback map) — grep `extractedFields` usage / inspect a real ingested doc.
- Whether page numbers are available at extraction time for scanned (vision) docs vs text PDFs
  — text PDFs: yes via pdf-parse page split; scanned: per-image page index.
- How the SAO officer/role is represented in the existing auth/role model (reuse, don't invent).
