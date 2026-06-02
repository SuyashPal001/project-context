# taskExecution workflow

Mastra-native workflow for executing research and job-search tasks.
Registered as `task-execution` in the Mastra instance (`index.ts`).

## What it does

Given a task title and optional context, the workflow:

1. Breaks the task into 2–4 targeted search queries
2. Runs each query in parallel using Exa (live web search)
3. Merges and deduplicates all results
4. Formats the final output into a clean, readable summary

Currently optimised for job-search tasks. The step structure generalises
to any research task — only the compose prompt is job-specific.

---

## Input schema

| Field | Type | Required | Description |
|---|---|---|---|
| `taskTitle` | string | yes | The task heading shown on the board |
| `tenantId` | string | yes | Tenant UUID — used for memory isolation |
| `taskDescription` | string | no | Free-text context about the task |
| `acceptanceCriteria` | string | no | Definition of done — injected into plan and compose prompts |
| `attachmentContext` | string | no | Pre-extracted text from uploaded files (built by `extractAttachments()` in taskWorker) |
| `referenceText` | string | no | User-provided background text attached at task creation |
| `links` | string[] | no | URLs the user attached — listed in the plan prompt for context |

`attachmentContext`, `referenceText`, and `links` are all injected into
`planStep` so the agent can factor them into query generation.

---

## Step structure

```
workflowInput
     │
     ▼
┌──────────┐
│ planStep │  platformAgent, activeTools: []
│  (plan)  │  Parses task + context → returns [{ query }, { query }, ...]
└──────────┘
     │  z.array(z.object({ query: z.string() }))
     ▼
┌─────────────────────────────────────────┐
│         foreach(searchStep, { concurrency: 3 })         │
│                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ search 1 │  │ search 2 │  │ search 3 │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│                                         │
│  Pass 1: platformAgent + internet_search (Exa, live crawl) │
│  Pass 2: formatterAgent + structuredOutput (no tools)   │
└─────────────────────────────────────────┘
     │  searchOutputSchema[]
     ▼
┌───────────┐
│ mergeStep │  Pure JS — no LLM call
│  (merge)  │  Filters status==='done', flatMaps jobs, deduplicates
└───────────┘  by lowercase company::title key
     │  { jobs, totalFound }
     ▼
┌──────────────┐
│ composeStep  │  platformAgent, activeTools: [], structuredOutput
│  (compose)   │  Formats full job list into human-readable summary
└──────────────┘
     │
     ▼
  { summary, status, reasoning }
```

### Two-pass Gemini conflict fix (searchStep)

Gemini cannot use `responseSchema` (structured output) and
`functionDeclarations` (tool calls) in the same request.

- **Pass 1** — `platformAgent.generate()` with `activeTools: ['internet_search']`,
  no `structuredOutput` → returns free text with job listings
- **Pass 2** — `formatterAgent.generate()` with `structuredOutput`, no tools
  → extracts structured `{ jobs, status }` from the Pass 1 text

`formatterAgent` is a separate Agent instance with `tools: {}` so Gemini
uses `responseSchema` without conflict.

---

## How to test in Mastra Studio

The workflow is registered in the `mastra` instance and available in Studio.

1. Open Studio (check `pm2 list` for the `mastra-studio` port)
2. Navigate to **Workflows** → **task-execution**
3. Click **Trigger** and paste the input JSON:

```json
{
  "taskTitle": "Find senior backend engineer jobs in Bangalore",
  "taskDescription": "Remote or hybrid, Node.js or Go, 5+ years experience",
  "tenantId": "<any-valid-tenant-uuid>",
  "acceptanceCriteria": "At least 5 jobs with company name, title, location, and apply URL"
}
```

4. Watch the step graph execute: plan → 3× search → merge → compose
5. The final `summary` field in the compose output is what the user sees

To test with attachments, pass `attachmentContext` as a pre-extracted string
(same format `extractAttachments()` produces: `[Attachment: filename]\ncontent`).

---

## What's next

### Wire to task board

`taskExecution.ts` currently runs Studio-only. To connect it to the task board:

- `app.ts` `POST /api/tasks/execute` already calls `runMastraWorkflow()` from
  `workflow.ts` when `USE_MASTRA_TASKS=true` — that path runs the **step-loop
  workflow** (not this Mastra-native workflow)
- To use this workflow for task board execution, add a new code path in
  `runMastraTaskSteps()` that calls `mastra.getWorkflow('task-execution').execute(input)`
  and maps the `summary` output back to `onStepComplete` callbacks
- Input mapping: `taskTitle`, `taskDescription`, `acceptanceCriteria`,
  `attachmentContext`, `referenceText`, `links` all come from the existing
  `WorkflowContext` in `workflow.ts`

### Suspend / resume (human-in-the-loop)

Mastra supports `.suspend()` and `.resume()` within steps for human approval gates.

Planned use cases:
- **High-stakes tool approval** — suspend before calling a destructive MCP tool,
  resume after the user confirms in the task board UI
- **Clarification required** — suspend when the agent returns
  `status: 'needs_clarification'`, resume after the user replies

Implementation sketch:
```typescript
// Inside a step execute():
const { resume } = await suspend({ question: 'Confirm sending this email?' })
const approved = await resume  // blocks until task board calls workflow.resume(runId)
if (!approved) return { status: 'failed', summary: 'User declined.' }
```

The task board would call `mastra.getWorkflow('task-execution').resume(runId, payload)`
via a new internal endpoint when the user clicks Approve/Reject.
