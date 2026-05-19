# PM Agent Architecture

Two entry points. Same agents. Different execution modes.

---

## The Two Modes

### 1. Chat Mode (conversational, user-driven)

User opens chat → types a PM request → relay routes to the right Mastra agent.

```
User message
    │
    ▼
chatStream.ts  ──  isPmIntent(message)?
    │                    │
    │            yes ────┤
    │                    ▼
    │              pmAgent.stream()          ← supervisor
    │                    │
    │           delegates via tool calls
    │                    │
    │        ┌───────────┼───────────┐
    │        ▼           ▼           ▼
    │   prdAgent    roadmapAgent  taskAgent
    │        │           │           │
    │        ▼           ▼           ▼
    │   prdWorkflow roadmapWorkflow taskWorkflow
    │        │           │           │
    │        ▼           ▼           ▼
    │     saves to DB  saves to DB  saves to DB
    │        │           │           │
    │        └─────── returns IDs ───┘
    │                    │
    │            back to pmAgent
    │            back to user (streamed)
    │
    no ──────► platformAgent.stream()        ← general assistant
```

HITL in chat mode is **conversational** — the agent asks the user to review what it built, user replies, agent refines. Mastra memory (PgVector, thread-scoped) keeps context across turns so the agent remembers the prdId/planId it just created.

### 2. Schedule Mode (automated, time-triggered)

User schedules a cron job from the UI → Mastra scheduler fires pmWorkflow on the cron tick.

```
Cron tick (Mastra scheduler, every 30s check)
    │
    ▼
pmWorkflow
    │
    ├── prdStep
    │       invokes prdWorkflow
    │       saves PRD to DB → prdId
    │       SUSPENDS ← user must approve via notification inbox
    │
    │   (user approves in UI → resume endpoint called)
    │
    ├── roadmapStep
    │       invokes roadmapWorkflow
    │       saves plan to DB → planId
    │       activates plan (status: draft → active)
    │       SUSPENDS ← user must approve
    │
    │   (user approves)
    │
    └── taskStep
            fetches active plan (fetchPlan)
            invokes taskWorkflow
            saves tasks to DB → taskCount
            DONE (no approval gate — tasks are final)
```

HITL in schedule mode is **durable suspend/resume** — Mastra checkpoints workflow state, sends a notification to the user's inbox, user clicks Approve in the UI which calls the workflow resume endpoint.

---

## What Lives Where

### Relay (`apps/relay/src/mastra/`)

| File | Role |
|---|---|
| `agents/pmAgent.ts` | Supervisor — classifies intent, delegates to sub-agents via tool calls |
| `agents/prdAgent.ts` | PRD specialist — invokes prdWorkflow, returns prdId |
| `agents/roadmapAgent.ts` | Roadmap specialist — invokes roadmapWorkflow, returns planId |
| `agents/taskAgent.ts` | Task specialist — invokes taskWorkflow, returns taskCount |
| `agents/formatterAgent.ts` | No-tool formatting helper — used inside workflows for JSON structuring |
| `workflows/pmWorkflow.ts` | Automated pipeline: prdStep → roadmapStep → taskStep (schedule path only) |
| `workflows/prdWorkflow.ts` | gather → write → format → savePRD (self-contained, saves to DB, returns prdId) |
| `workflows/roadmapWorkflow.ts` | analyze → plan → format → savePlan (self-contained, returns planId) |
| `workflows/taskWorkflow.ts` | analyze → generate → format → saveTasks (self-contained, returns taskCount) |
| `routes/chatStream.ts` | SSE stream handler — routes to pmAgent or platformAgent based on intent |
| `routes/pmRouting.ts` | `isPmIntent(message)` — keyword/intent classifier |
| `routes/schedules.ts` | REST API: POST/GET/DELETE /schedules — wraps Mastra SchedulesPG |
| `index.ts` | Mastra instance — registers all agents + workflows + scheduler |

### Frontend (`apps/web/`)

| File | Role |
|---|---|
| `app/[tenant]/dashboard/chat/page.tsx` | Chat page — routes to WelcomeView on first message |
| `components/platform/chat/WelcomeView.tsx` | Empty-state screen with 4 PM-relevant suggestion pills |
| `components/platform/chat/WizardView.tsx` | Two-step wizard that builds a prompt and calls sendMessage |
| `components/platform/chat/wizards/prd.tsx` | PRD wizard — feature name + audience → prompt |
| `components/platform/chat/wizards/roadmap.tsx` | Roadmap wizard — product + horizon → prompt |
| `components/platform/chat/wizards/tasks.tsx` | Task breakdown wizard — feature + team → prompt |
| `components/platform/chat/wizards/research.tsx` | Research wizard — topic + depth → prompt |
| `app/[tenant]/dashboard/agents/[agentId]/scheduled/page.tsx` | Scheduled runs UI — list + create + delete |
| `app/[tenant]/dashboard/agents/[agentId]/scheduled/NewScheduleDialog.tsx` | Create schedule form |
| `app/[tenant]/dashboard/agents/[agentId]/scheduled/relayClient.ts` | Direct relay fetch helpers (uses platform_id_token cookie) |

### API Layer (Lambda, `apps/api/`)

| File | Role |
|---|---|
| `routes/pm.ts` | Workflow resume endpoint: `POST /pm/workflow/:runId/resume` |

---

## Sub-Workflow Contract

Each sub-workflow is **self-contained**: it takes content in, saves to DB itself, returns IDs out. No parent workflow or agent does DB work.

| Workflow | Input | Saves | Returns |
|---|---|---|---|
| `prdWorkflow` | `userMessage: string` | `product_documents` (type=prd) | `{ prdId, prdContent }` |
| `roadmapWorkflow` | `prdContent: string` | `project_plans` + `project_milestones` | `{ planId, title }` |
| `taskWorkflow` | `planData: string` (JSON) | `agent_tasks` | `{ planId, taskCount }` |

---

## pmWorkflow Step-by-Step (schedule path)

```
Input: { userPrompt: string }  ← from schedule's templatePrompt

prdStep:
  1. Calls prdWorkflow → PRD written and saved → prdId returned
  2. suspend({ phase: 'prd', prdId, title })
  3. Mastra sends notification to user inbox
  4. User approves in UI → POST /pm/workflow/:runId/resume { approved: true }
  5. OR user sends revision → resume { revise: "make it shorter" } → re-runs prdWorkflow
  6. On approval: fetches PRD content (allowDraft: true) and passes to roadmapStep

roadmapStep:
  1. Calls roadmapWorkflow → plan saved → planId returned
  2. Activates plan: UPDATE project_plans SET status='active' (so fetchPlan works)
  3. suspend({ phase: 'roadmap', planId, title })
  4. User approves → resumes
  5. Returns { planId, title } to taskStep

taskStep:
  1. fetchPlan(planId) → gets plan + milestones with real UUIDs
  2. Calls taskWorkflow → tasks generated and saved
  3. Returns { planId, taskCount }
  4. Workflow complete
```

---

## Key Design Decisions

**Why sub-workflows save their own data (not pmWorkflow)**
Each sub-workflow is reusable independently — a sub-agent can call prdWorkflow without knowing about the parent pmWorkflow. pmWorkflow chains outputs (IDs) not raw content.

**Why plan status must be 'active' before taskStep**
`fetchPlan` filters `WHERE status = 'active'`. Roadmap is saved as 'draft' by roadmapWorkflow. pmWorkflow explicitly activates it (`UPDATE status='active'`) after roadmapStep so taskStep can retrieve the milestone IDs.

**Why pmAgent is a supervisor, not a workflow**
Chat is iterative — user asks questions, revises, goes back. Workflows are deterministic pipelines. pmAgent orchestrates conversationally via delegation; pmWorkflow orchestrates deterministically via chained steps.

**Why two separate paths exist**
Schedule path needs durability (survives relay restarts, retries on failure, full audit log of each step). Chat path needs low latency streaming — suspend/resume checkpointing adds ~1-2s overhead that's unacceptable in chat.

**Why chatStream routes by message intent (not by agent DB record)**
The relay always uses internal Mastra agents (pmAgent, platformAgent). DB agents (Saarthi) are the user-facing identity. The routing key is message content, not which DB agent the conversation belongs to.

---

## Scheduler

- Mastra native scheduler (`scheduler: { enabled: true, tickIntervalMs: 30_000 }` in `index.ts`)
- Storage: `SchedulesPG` domain inside the same PostgresStore (no separate table needed)
- Schedule records stored with `metadata: { agentId, tenantId }` for frontend filtering
- `POST /schedules` → `schedulesStore.createSchedule({ workflowId: 'pm-workflow', cron, inputData: { userPrompt } })`
- Frontend calls relay directly at `https://agent-saas.fitnearn.com/schedules` with `platform_id_token` cookie as Bearer token + `X-Agent-Id` header

---

## Adding a New PM Capability

1. Add a wizard in `apps/web/components/platform/chat/wizards/<name>.tsx`
2. Add the PillType to `types.ts` and wire in `WizardView.tsx`
3. Add the pill to `WelcomeView.tsx` SUGGESTED_PROMPTS
4. If it needs a new sub-workflow: create in `apps/relay/src/mastra/workflows/`, register in `index.ts`
5. If pmAgent should delegate to it: add a tool call in `pmAgent.ts` pointing to the new sub-agent
