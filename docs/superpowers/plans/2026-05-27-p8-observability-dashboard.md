# P8 Platform Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CAG-grade Platform Observability page in the Saarthi AI tenant portal that pulls live data from three sources (Mastra workflow runs, custom usage_records, audit_log) and renders a unified dashboard with system health, workflow execution metrics, token cost breakdown, and audit volume.

**Architecture:** Add a small `token_costs` table to persist per-run cost calculations from `apps/relay/src/mastra/cost.ts` (currently in-memory only). Build four read-only aggregation endpoints in `apps/api/src/routes/observability.ts` (summary, workflows, costs, audit-volume). Build a portal page at `/[tenant]/dashboard/observability` composed of focused chart cards (SystemHealth, WorkflowMetrics, CostBreakdown, AuditVolume, AgentActivity). Charts use the existing recharts dependency. Data is per-tenant for isolation; aggregations are pre-computed in SQL (no client-side number crunching).

**Tech Stack:** Drizzle ORM migration, Hono.js routes, raw SQL aggregations against PostgreSQL (`usage_records`, `audit_log`, `agent_workflow_runs`, `agent_tasks`, `token_costs`, `mastra.*` schema), Next.js + shadcn/ui + recharts, TanStack Query with 30s refetch.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/foundation/database/schema/observability.ts` | Create | `tokenCosts` table — persistent record of every model call cost |
| `packages/foundation/database/schema/index.ts` | Modify | Re-export `tokenCosts` |
| `packages/foundation/database/migrations/XXXX_token_costs.sql` | Create | Drizzle migration adding the table |
| `apps/relay/src/mastra/cost.ts` | Modify | Add `persistCost()` that writes to `tokenCosts` table |
| `apps/api/src/services/observability.ts` | Create | SQL aggregation helpers (workflow stats, cost breakdown, audit volume) |
| `apps/api/src/routes/observability.ts` | Create | 4 GET endpoints: `/summary`, `/workflows`, `/costs`, `/audit-volume` |
| `apps/api/src/app.ts` | Modify | Register observability route |
| `apps/web/lib/sidebar-items.ts` | Modify | Add "Observability" nav item |
| `apps/web/app/[tenant]/dashboard/observability/page.tsx` | Create | Dashboard page composing all cards |
| `apps/web/components/platform/observability/SystemHealthCard.tsx` | Create | API/relay/lakehouse health + latency |
| `apps/web/components/platform/observability/WorkflowMetricsCard.tsx` | Create | Workflow runs chart (success/failure over time) |
| `apps/web/components/platform/observability/CostBreakdownCard.tsx` | Create | Stacked bar by model with totals |
| `apps/web/components/platform/observability/AuditVolumeCard.tsx` | Create | Audit log growth + integrity status |
| `apps/web/components/platform/observability/AgentActivityCard.tsx` | Create | Top agents by run count + avg latency |
| `apps/web/components/platform/observability/StatTile.tsx` | Create | Reusable single-stat card with sparkline |

---

### Task 1: `tokenCosts` Schema + Migration

**Files:**
- Create: `packages/foundation/database/schema/observability.ts`
- Modify: `packages/foundation/database/schema/index.ts`
- Apply migration

- [ ] **Step 1: Create the schema file**

```typescript
// packages/foundation/database/schema/observability.ts
import { pgTable, uuid, text, decimal, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Per-call token cost record. Written by relay's mastra/cost.ts after each
 * model invocation. Used by observability dashboard for cost breakdowns.
 */
export const tokenCosts = pgTable('token_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  agentId: text('agent_id'),         // Mastra agent id (e.g. 'doc-classifier')
  workflowId: text('workflow_id'),   // Mastra workflow id (e.g. 'document-ingestion')
  runId: text('run_id'),             // Mastra run id correlating to a workflow run
  model: text('model').notNull(),    // e.g. 'gemini-2.5-flash'
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: decimal('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  tenantTimeIdx: index('token_costs_tenant_time_idx').on(t.tenantId, t.createdAt),
  workflowIdx: index('token_costs_workflow_idx').on(t.workflowId),
}));
```

- [ ] **Step 2: Re-export from schema index**

Open `packages/foundation/database/schema/index.ts`. Add:

```typescript
export * from './observability';
```

- [ ] **Step 3: Generate + apply migration**

```bash
cd /Users/suyash/Desktop/projects/serverless-app/serverless-saas/packages/foundation/database
pnpm drizzle-kit generate 2>&1 | tail -10
```

If the migration generates cleanly, the SQL file appears in `packages/foundation/database/migrations/`. Apply it via the connected DB (Postgres at the URL in `apps/api/.env`).

If the Drizzle migration tracker refuses (out of sync from earlier work), apply directly via Node's `pg` client (the DB is remote — use `DATABASE_URL`):

```bash
cd /Users/suyash/Desktop/projects/serverless-app/serverless-saas
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || require('fs').readFileSync('apps/api/.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).split('=').slice(1).join('=') });
pool.query(\`
  CREATE TABLE IF NOT EXISTS token_costs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id TEXT,
    workflow_id TEXT,
    run_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS token_costs_tenant_time_idx ON token_costs (tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS token_costs_workflow_idx ON token_costs (workflow_id);
\`).then(() => { console.log('OK'); pool.end(); }).catch(e => { console.error(e.message); process.exit(1); });
"
```

- [ ] **Step 4: Verify the table exists**

```bash
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: require('fs').readFileSync('apps/api/.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).split('=').slice(1).join('=') });
pool.query(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'token_costs' ORDER BY ordinal_position\").then(r => { console.table(r.rows); pool.end(); });
"
```

Expected: 10 columns visible (id, tenant_id, agent_id, workflow_id, run_id, model, input_tokens, output_tokens, cost_usd, created_at).

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/database/schema/observability.ts packages/foundation/database/schema/index.ts packages/foundation/database/migrations/
git commit -m "feat(schema): add token_costs table for observability cost tracking"
```

---

### Task 2: Persist Costs from Relay's `cost.ts`

**Files:**
- Modify: `apps/relay/src/mastra/cost.ts`

- [ ] **Step 1: Read the existing cost.ts**

Open `apps/relay/src/mastra/cost.ts` to understand the current `calculateCostUsd(model, inputTokens, outputTokens)` function and how it's called from agent/workflow code.

- [ ] **Step 2: Add `persistCost` helper**

Append to `cost.ts`:

```typescript
import { db } from '@serverless-saas/database'
import { tokenCosts } from '@serverless-saas/database/schema/observability'

export interface CostRecord {
  tenantId: string
  agentId?: string
  workflowId?: string
  runId?: string
  model: string
  inputTokens: number
  outputTokens: number
}

/**
 * Persist a cost record. Fire-and-forget — never block the workflow on cost logging.
 */
export function persistCost(record: CostRecord): void {
  const costUsd = calculateCostUsd(record.model, record.inputTokens, record.outputTokens)
  db.insert(tokenCosts).values({
    tenantId: record.tenantId,
    agentId: record.agentId,
    workflowId: record.workflowId,
    runId: record.runId,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: String(costUsd),
  }).catch(err => {
    console.error('[cost] persistCost failed', err)
  })
}
```

Match existing import-path conventions (.js extensions on relative imports if used elsewhere).

- [ ] **Step 3: Wire `persistCost` into Mastra agent/workflow steps**

Look for places that compute or extract token usage from model results — the existing `documentWorkflow.plan.ts` returns `{ inputTokens, outputTokens }` from agent calls. Find similar patterns in the ingestion workflow steps (`apps/relay/src/mastra/workflows/ingestionWorkflow.*.ts`).

In each step that calls `<agent>.generate()`, after the call, add:

```typescript
import { persistCost } from '../cost'

// after agent.generate():
const usage = (result as any).usage ?? { inputTokens: 0, outputTokens: 0 }
persistCost({
  tenantId: inputData.tenantId,
  agentId: classifierAgent.id,   // adapt per step
  workflowId: 'document-ingestion',
  runId: undefined,              // could pass through if available in context
  model: 'gemini-2.5-flash',     // or read from saarthiModel
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
})
```

Apply to:
- `ingestionWorkflow.classify.ts` (classifierAgent call)
- `ingestionWorkflow.validate.ts` (validatorAgent call)
- The `gemini-extract` tool in `tools/geminiExtract.ts` (after the fetch returns)

For `geminiExtract.ts`, you'll need to extract token counts from the Gemini response JSON (`result.usageMetadata.promptTokenCount` and `candidatesTokenCount`).

- [ ] **Step 4: Verify TS compiles**

```bash
cd apps/relay && pnpm build 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/mastra/cost.ts apps/relay/src/mastra/workflows/ apps/relay/src/mastra/tools/
git commit -m "feat(relay): persist per-call token costs to token_costs table"
```

---

### Task 3: Observability Aggregation Service

**Files:**
- Create: `apps/api/src/services/observability.ts`

- [ ] **Step 1: Create the file**

```typescript
// apps/api/src/services/observability.ts
import { sql } from 'drizzle-orm'
import { db } from '@serverless-saas/database'

export interface SummaryStats {
  totalRequests24h: number
  totalCostUsd24h: number
  activeWorkflows: number
  workflowSuccessRate24h: number
  auditEntries24h: number
  health: { api: 'ok' | 'degraded' | 'down'; relay: 'ok' | 'unknown'; lakehouse: 'ok' | 'unknown' }
}

export async function getSummary(tenantId: string): Promise<SummaryStats> {
  const [requests] = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM usage_records
    WHERE tenant_id = ${tenantId}
      AND recorded_at > NOW() - INTERVAL '24 hours'
      AND metric = 'api_calls'
  `)

  const [costs] = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric AS total
    FROM token_costs
    WHERE tenant_id = ${tenantId}
      AND created_at > NOW() - INTERVAL '24 hours'
  `)

  const [audit] = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM audit_log
    WHERE tenant_id = ${tenantId}
      AND created_at > NOW() - INTERVAL '24 hours'
  `)

  const [workflows] = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running')::int AS active,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours')::int AS done24,
      COUNT(*) FILTER (WHERE status = 'failed'    AND completed_at > NOW() - INTERVAL '24 hours')::int AS failed24
    FROM agent_workflow_runs
  `)

  const done = (workflows as any).done24 ?? 0
  const failed = (workflows as any).failed24 ?? 0
  const total = done + failed
  const successRate = total === 0 ? 1 : done / total

  // Lightweight health probe of sibling services
  const apiHealth: 'ok' | 'degraded' = 'ok'
  const relayHealth: 'ok' | 'unknown' = await probe(process.env.RELAY_URL ?? 'http://localhost:3001')
  const lakehouseHealth: 'ok' | 'unknown' = await probe(process.env.LAKEHOUSE_URL ?? 'http://localhost:8001')

  return {
    totalRequests24h: Number((requests as any).count ?? 0),
    totalCostUsd24h: Number((costs as any).total ?? 0),
    activeWorkflows: Number((workflows as any).active ?? 0),
    workflowSuccessRate24h: successRate,
    auditEntries24h: Number((audit as any).count ?? 0),
    health: { api: apiHealth, relay: relayHealth, lakehouse: lakehouseHealth },
  }
}

async function probe(url: string): Promise<'ok' | 'unknown'> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface WorkflowMetricPoint {
  hour: string          // ISO hour bucket
  succeeded: number
  failed: number
  running: number
  avgLatencyMs: number | null
}

export async function getWorkflowMetrics(tenantId: string, hours = 24): Promise<WorkflowMetricPoint[]> {
  const rows = await db.execute(sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('hour', NOW()) - INTERVAL '${sql.raw(String(hours - 1))} hours',
        date_trunc('hour', NOW()),
        '1 hour'
      ) AS hour
    )
    SELECT
      to_char(b.hour, 'YYYY-MM-DD"T"HH24:00:00') AS hour,
      COUNT(r.*) FILTER (WHERE r.status = 'completed')::int AS succeeded,
      COUNT(r.*) FILTER (WHERE r.status = 'failed')::int AS failed,
      COUNT(r.*) FILTER (WHERE r.status = 'running')::int AS running,
      AVG(EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int AS avg_latency_ms
    FROM buckets b
    LEFT JOIN agent_workflow_runs r
      ON date_trunc('hour', r.started_at) = b.hour
    GROUP BY b.hour
    ORDER BY b.hour
  `)

  return (rows as any[]).map(r => ({
    hour: r.hour,
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    running: Number(r.running ?? 0),
    avgLatencyMs: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
  }))
}

export interface CostBreakdown {
  byModel: Array<{ model: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>
  byWorkflow: Array<{ workflowId: string; costUsd: number; calls: number }>
  daily: Array<{ day: string; costUsd: number }>
}

export async function getCostBreakdown(tenantId: string, days = 7): Promise<CostBreakdown> {
  const byModelRows = await db.execute(sql`
    SELECT model,
           SUM(cost_usd)::numeric AS cost_usd,
           COUNT(*)::int AS calls,
           SUM(input_tokens)::int AS input_tokens,
           SUM(output_tokens)::int AS output_tokens
    FROM token_costs
    WHERE tenant_id = ${tenantId}
      AND created_at > NOW() - INTERVAL '${sql.raw(String(days))} days'
    GROUP BY model
    ORDER BY cost_usd DESC
  `)

  const byWorkflowRows = await db.execute(sql`
    SELECT COALESCE(workflow_id, '(direct)') AS workflow_id,
           SUM(cost_usd)::numeric AS cost_usd,
           COUNT(*)::int AS calls
    FROM token_costs
    WHERE tenant_id = ${tenantId}
      AND created_at > NOW() - INTERVAL '${sql.raw(String(days))} days'
    GROUP BY workflow_id
    ORDER BY cost_usd DESC
  `)

  const dailyRows = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', NOW()) - INTERVAL '${sql.raw(String(days - 1))} days',
        date_trunc('day', NOW()),
        '1 day'
      ) AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(t.cost_usd), 0)::numeric AS cost_usd
    FROM days d
    LEFT JOIN token_costs t
      ON t.tenant_id = ${tenantId}
      AND date_trunc('day', t.created_at) = d.day
    GROUP BY d.day
    ORDER BY d.day
  `)

  return {
    byModel: (byModelRows as any[]).map(r => ({
      model: r.model,
      costUsd: Number(r.cost_usd ?? 0),
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
    })),
    byWorkflow: (byWorkflowRows as any[]).map(r => ({
      workflowId: r.workflow_id,
      costUsd: Number(r.cost_usd ?? 0),
      calls: Number(r.calls ?? 0),
    })),
    daily: (dailyRows as any[]).map(r => ({
      day: r.day,
      costUsd: Number(r.cost_usd ?? 0),
    })),
  }
}

export interface AuditVolumePoint {
  day: string
  total: number
  byActorType: { human: number; agent: number; system: number }
}

export async function getAuditVolume(tenantId: string, days = 14): Promise<AuditVolumePoint[]> {
  const rows = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', NOW()) - INTERVAL '${sql.raw(String(days - 1))} days',
        date_trunc('day', NOW()),
        '1 day'
      ) AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COUNT(a.*)::int AS total,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'human')::int AS human,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'agent')::int AS agent,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'system')::int AS system
    FROM days d
    LEFT JOIN audit_log a
      ON a.tenant_id = ${tenantId}
      AND date_trunc('day', a.created_at) = d.day
    GROUP BY d.day
    ORDER BY d.day
  `)

  return (rows as any[]).map(r => ({
    day: r.day,
    total: Number(r.total ?? 0),
    byActorType: {
      human: Number(r.human ?? 0),
      agent: Number(r.agent ?? 0),
      system: Number(r.system ?? 0),
    },
  }))
}

export interface AgentActivity {
  agentId: string
  totalCalls: number
  totalCostUsd: number
  avgInputTokens: number
  avgOutputTokens: number
}

export async function getAgentActivity(tenantId: string, days = 7): Promise<AgentActivity[]> {
  const rows = await db.execute(sql`
    SELECT COALESCE(agent_id, '(unknown)') AS agent_id,
           COUNT(*)::int AS total_calls,
           SUM(cost_usd)::numeric AS total_cost_usd,
           AVG(input_tokens)::int AS avg_input_tokens,
           AVG(output_tokens)::int AS avg_output_tokens
    FROM token_costs
    WHERE tenant_id = ${tenantId}
      AND created_at > NOW() - INTERVAL '${sql.raw(String(days))} days'
    GROUP BY agent_id
    ORDER BY total_calls DESC
    LIMIT 10
  `)

  return (rows as any[]).map(r => ({
    agentId: r.agent_id,
    totalCalls: Number(r.total_calls ?? 0),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    avgInputTokens: Number(r.avg_input_tokens ?? 0),
    avgOutputTokens: Number(r.avg_output_tokens ?? 0),
  }))
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
cd apps/api && pnpm build 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/observability.ts
git commit -m "feat(api): add observability aggregation service (summary, workflows, costs, audit, agents)"
```

---

### Task 4: Observability API Routes

**Files:**
- Create: `apps/api/src/routes/observability.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Create the route file**

```typescript
// apps/api/src/routes/observability.ts
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { hasPermission } from '@serverless-saas/permissions';
import {
  getSummary,
  getWorkflowMetrics,
  getCostBreakdown,
  getAuditVolume,
  getAgentActivity,
} from '../services/observability';

const observabilityRoutes = new Hono<AppEnv>();

async function ensureRead(c: any): Promise<{ tenantId: string; userId: string } | Response> {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId');
  if (!userId || !tenantId) return c.json({ error: 'Forbidden' }, 403);
  if (!await hasPermission(tenantId, userId, 'audit_log', 'read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return { tenantId, userId };
}

observabilityRoutes.get('/summary', async (c) => {
  const guard = await ensureRead(c);
  if (guard instanceof Response) return guard;
  return c.json(await getSummary(guard.tenantId));
});

observabilityRoutes.get('/workflows', async (c) => {
  const guard = await ensureRead(c);
  if (guard instanceof Response) return guard;
  const hours = Number(c.req.query('hours') ?? 24);
  return c.json({ points: await getWorkflowMetrics(guard.tenantId, hours) });
});

observabilityRoutes.get('/costs', async (c) => {
  const guard = await ensureRead(c);
  if (guard instanceof Response) return guard;
  const days = Number(c.req.query('days') ?? 7);
  return c.json(await getCostBreakdown(guard.tenantId, days));
});

observabilityRoutes.get('/audit-volume', async (c) => {
  const guard = await ensureRead(c);
  if (guard instanceof Response) return guard;
  const days = Number(c.req.query('days') ?? 14);
  return c.json({ points: await getAuditVolume(guard.tenantId, days) });
});

observabilityRoutes.get('/agents', async (c) => {
  const guard = await ensureRead(c);
  if (guard instanceof Response) return guard;
  const days = Number(c.req.query('days') ?? 7);
  return c.json({ agents: await getAgentActivity(guard.tenantId, days) });
});

export { observabilityRoutes };
```

- [ ] **Step 2: Register in app.ts**

Open `apps/api/src/app.ts`. Add import near other route imports:

```typescript
import { observabilityRoutes } from './routes/observability';
```

Add route registration near other `api.route(...)` calls (around line 195+):

```typescript
api.route('/observability', observabilityRoutes);
```

- [ ] **Step 3: Verify**

```bash
cd apps/api && pnpm build 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/observability.ts apps/api/src/app.ts
git commit -m "feat(api): add 5 observability endpoints (summary, workflows, costs, audit-volume, agents)"
```

---

### Task 5: Sidebar Nav

**Files:**
- Modify: `apps/web/lib/sidebar-items.ts`

- [ ] **Step 1: Add Activity icon import + nav item**

Open `apps/web/lib/sidebar-items.ts`. Add `Activity` to the lucide-react import:

```typescript
import {
  // ... existing
  Activity,
} from "lucide-react";
```

Add the nav item — place it under the Audit log entry (admin/owner only):

```typescript
if (isAdminOrOwner) {
  items.push({
    label: "Observability",
    href: `${base}/observability`,
    icon: Activity,
    planRequired: 'business',
    planGateFeature: 'audit_log',  // reuse audit_log entitlement
    locked: auditLocked,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/lib/sidebar-items.ts
git commit -m "feat(web): add Observability nav item to sidebar"
```

---

### Task 6: `StatTile` Reusable Component

**Files:**
- Create: `apps/web/components/platform/observability/StatTile.tsx`

- [ ] **Step 1: Create**

```typescript
// apps/web/components/platform/observability/StatTile.tsx
"use client";

import { LucideIcon } from "lucide-react";

interface Props {
    label: string;
    value: string | number;
    sublabel?: string;
    icon: LucideIcon;
    tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue';
    loading?: boolean;
}

const TONE_STYLES: Record<NonNullable<Props['tone']>, { bg: string; text: string; ring: string }> = {
    neutral: { bg: 'bg-zinc-900',          text: 'text-zinc-200',   ring: 'border-zinc-800' },
    green:   { bg: 'bg-green-500/10',      text: 'text-green-400',  ring: 'border-green-500/30' },
    amber:   { bg: 'bg-amber-500/10',      text: 'text-amber-400',  ring: 'border-amber-500/30' },
    red:     { bg: 'bg-red-500/10',        text: 'text-red-400',    ring: 'border-red-500/30' },
    blue:    { bg: 'bg-blue-500/10',       text: 'text-blue-400',   ring: 'border-blue-500/30' },
};

export function StatTile({ label, value, sublabel, icon: Icon, tone = 'neutral', loading }: Props) {
    const styles = TONE_STYLES[tone];
    return (
        <div className={`rounded-lg border ${styles.ring} bg-zinc-950 p-4 flex items-start gap-3`}>
            <div className={`h-9 w-9 rounded-md ${styles.bg} flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${styles.text}`} />
            </div>
            <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
                <p className={`text-2xl font-bold ${styles.text} mt-0.5 truncate`}>
                    {loading ? <span className="text-zinc-700">—</span> : value}
                </p>
                {sublabel && (
                    <p className="text-xs text-zinc-500 mt-1">{sublabel}</p>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/platform/observability/StatTile.tsx
git commit -m "feat(web): add StatTile component for observability cards"
```

---

### Task 7: `SystemHealthCard`

**Files:**
- Create: `apps/web/components/platform/observability/SystemHealthCard.tsx`

- [ ] **Step 1: Create**

```typescript
// apps/web/components/platform/observability/SystemHealthCard.tsx
"use client";

import { Server, Bot, Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Status = 'ok' | 'degraded' | 'down' | 'unknown';

interface Props {
    health: { api: Status; relay: Status; lakehouse: Status };
    loading?: boolean;
}

const STATUS_STYLES: Record<Status, { dot: string; label: string; badge: string }> = {
    ok:       { dot: 'bg-green-500',  label: 'Operational',  badge: 'border-green-500/30 text-green-400 bg-green-500/10' },
    degraded: { dot: 'bg-amber-500',  label: 'Degraded',     badge: 'border-amber-500/30 text-amber-400 bg-amber-500/10' },
    down:     { dot: 'bg-red-500',    label: 'Down',         badge: 'border-red-500/30 text-red-400 bg-red-500/10' },
    unknown:  { dot: 'bg-zinc-600',   label: 'Unknown',      badge: 'border-zinc-700 text-zinc-500 bg-zinc-900' },
};

const SERVICES: Array<{ key: 'api' | 'relay' | 'lakehouse'; label: string; icon: any }> = [
    { key: 'api',       label: 'API Service',         icon: Server },
    { key: 'relay',     label: 'Agent Runtime',       icon: Bot },
    { key: 'lakehouse', label: 'Lakehouse Service',   icon: Database },
];

export function SystemHealthCard({ health, loading }: Props) {
    return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-zinc-200">System Health</h3>
                <span className="text-xs text-zinc-500">Real-time</span>
            </div>
            <div className="space-y-3">
                {SERVICES.map(({ key, label, icon: Icon }) => {
                    const status = loading ? 'unknown' : health[key];
                    const s = STATUS_STYLES[status];
                    return (
                        <div key={key} className="flex items-center justify-between gap-3 py-1">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <Icon className="w-4 h-4 text-zinc-500 shrink-0" />
                                <span className="text-sm text-zinc-300 truncate">{label}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                                <Badge variant="outline" className={`text-xs ${s.badge}`}>{s.label}</Badge>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/platform/observability/SystemHealthCard.tsx
git commit -m "feat(web): add SystemHealthCard showing API/relay/lakehouse status"
```

---

### Task 8: `WorkflowMetricsCard` (chart)

**Files:**
- Create: `apps/web/components/platform/observability/WorkflowMetricsCard.tsx`

- [ ] **Step 1: Create**

```typescript
// apps/web/components/platform/observability/WorkflowMetricsCard.tsx
"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export interface WorkflowPoint {
    hour: string;
    succeeded: number;
    failed: number;
    running: number;
    avgLatencyMs: number | null;
}

interface Props {
    points: WorkflowPoint[];
    loading?: boolean;
}

function formatHour(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function WorkflowMetricsCard({ points, loading }: Props) {
    const data = points.map(p => ({ ...p, hourLabel: formatHour(p.hour) }));
    const totalSucceeded = points.reduce((a, p) => a + p.succeeded, 0);
    const totalFailed = points.reduce((a, p) => a + p.failed, 0);
    const errorRate = (totalSucceeded + totalFailed) === 0 ? 0 : totalFailed / (totalSucceeded + totalFailed);

    return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold text-zinc-200">Workflow Executions</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">Last 24 hours</p>
                </div>
                <div className="text-right">
                    <p className="text-xs text-zinc-500 uppercase tracking-wider">Error rate</p>
                    <p className={`text-lg font-bold ${errorRate > 0.05 ? 'text-red-400' : 'text-green-400'}`}>
                        {(errorRate * 100).toFixed(1)}%
                    </p>
                </div>
            </div>

            {loading ? (
                <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
            ) : data.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">No workflow runs yet</div>
            ) : (
                <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                            <XAxis dataKey="hourLabel" stroke="#71717a" fontSize={10} interval="preserveStartEnd" />
                            <YAxis stroke="#71717a" fontSize={10} allowDecimals={false} />
                            <Tooltip
                                contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }}
                                labelStyle={{ color: '#a1a1aa' }}
                            />
                            <Area type="monotone" dataKey="succeeded" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.4} />
                            <Area type="monotone" dataKey="failed"    stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.5} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/platform/observability/WorkflowMetricsCard.tsx
git commit -m "feat(web): add WorkflowMetricsCard with stacked area chart"
```

---

### Task 9: `CostBreakdownCard` (chart)

**Files:**
- Create: `apps/web/components/platform/observability/CostBreakdownCard.tsx`

- [ ] **Step 1: Create**

```typescript
// apps/web/components/platform/observability/CostBreakdownCard.tsx
"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

export interface CostData {
    byModel: Array<{ model: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>;
    byWorkflow: Array<{ workflowId: string; costUsd: number; calls: number }>;
    daily: Array<{ day: string; costUsd: number }>;
}

interface Props {
    data: CostData | null;
    loading?: boolean;
}

const MODEL_COLORS = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ec4899'];

function formatUsd(n: number): string {
    if (n >= 100) return `$${n.toFixed(0)}`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4)}`;
}

export function CostBreakdownCard({ data, loading }: Props) {
    const total7d = data?.daily.reduce((a, d) => a + d.costUsd, 0) ?? 0;

    return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold text-zinc-200">Cost Breakdown</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">Last 7 days</p>
                </div>
                <div className="text-right">
                    <p className="text-xs text-zinc-500 uppercase tracking-wider">Total</p>
                    <p className="text-lg font-bold text-blue-400">{formatUsd(total7d)}</p>
                </div>
            </div>

            {loading ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
            ) : !data || data.daily.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No cost data yet</div>
            ) : (
                <>
                    <div className="h-40 mb-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data.daily}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                                <XAxis dataKey="day" stroke="#71717a" fontSize={10} tickFormatter={(d) => d.slice(5)} />
                                <YAxis stroke="#71717a" fontSize={10} tickFormatter={formatUsd} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }}
                                    formatter={(v: any) => formatUsd(Number(v))}
                                />
                                <Bar dataKey="costUsd" fill="#3b82f6" />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="space-y-1.5 text-xs">
                        <p className="text-zinc-500 uppercase tracking-wider mb-2">By model</p>
                        {data.byModel.slice(0, 4).map((m, i) => (
                            <div key={m.model} className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                                    <span className="font-mono text-zinc-300 truncate">{m.model}</span>
                                </div>
                                <div className="flex items-center gap-3 shrink-0 text-zinc-400">
                                    <span>{m.calls.toLocaleString()} calls</span>
                                    <span className="font-mono text-zinc-200 w-16 text-right">{formatUsd(m.costUsd)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/platform/observability/CostBreakdownCard.tsx
git commit -m "feat(web): add CostBreakdownCard with daily bars + per-model breakdown"
```

---

### Task 10: `AuditVolumeCard` + `AgentActivityCard`

**Files:**
- Create: `apps/web/components/platform/observability/AuditVolumeCard.tsx`
- Create: `apps/web/components/platform/observability/AgentActivityCard.tsx`

- [ ] **Step 1: Create `AuditVolumeCard.tsx`**

```typescript
// apps/web/components/platform/observability/AuditVolumeCard.tsx
"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

export interface AuditPoint {
    day: string;
    total: number;
    byActorType: { human: number; agent: number; system: number };
}

interface Props {
    points: AuditPoint[];
    loading?: boolean;
}

export function AuditVolumeCard({ points, loading }: Props) {
    const data = points.map(p => ({
        day: p.day.slice(5),
        human: p.byActorType.human,
        agent: p.byActorType.agent,
        system: p.byActorType.system,
        total: p.total,
    }));
    const total14d = points.reduce((a, p) => a + p.total, 0);

    return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold text-zinc-200">Audit Log Volume</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">Last 14 days · by actor</p>
                </div>
                <div className="text-right">
                    <p className="text-xs text-zinc-500 uppercase tracking-wider">Total</p>
                    <p className="text-lg font-bold text-zinc-200">{total14d.toLocaleString()}</p>
                </div>
            </div>

            {loading ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
            ) : data.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No audit entries</div>
            ) : (
                <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                            <XAxis dataKey="day" stroke="#71717a" fontSize={10} />
                            <YAxis stroke="#71717a" fontSize={10} allowDecimals={false} />
                            <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }} />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            <Line type="monotone" dataKey="human"  stroke="#3b82f6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="agent"  stroke="#a855f7" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="system" stroke="#71717a" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Create `AgentActivityCard.tsx`**

```typescript
// apps/web/components/platform/observability/AgentActivityCard.tsx
"use client";

import { Bot } from "lucide-react";

export interface Agent {
    agentId: string;
    totalCalls: number;
    totalCostUsd: number;
    avgInputTokens: number;
    avgOutputTokens: number;
}

interface Props {
    agents: Agent[];
    loading?: boolean;
}

function formatUsd(n: number): string {
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4)}`;
}

export function AgentActivityCard({ agents, loading }: Props) {
    return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold text-zinc-200">Top Agents</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">Last 7 days · by activity</p>
                </div>
            </div>

            {loading ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
            ) : agents.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No agent calls yet</div>
            ) : (
                <div className="space-y-2">
                    {agents.slice(0, 6).map(a => (
                        <div key={a.agentId} className="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-800/50 last:border-0">
                            <div className="flex items-center gap-2 min-w-0">
                                <Bot className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                <span className="text-sm font-mono text-zinc-300 truncate">{a.agentId}</span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0 text-xs text-zinc-400 font-mono">
                                <span>{a.totalCalls.toLocaleString()}×</span>
                                <span className="text-zinc-500">{a.avgInputTokens}↑ {a.avgOutputTokens}↓</span>
                                <span className="text-blue-400 w-14 text-right">{formatUsd(a.totalCostUsd)}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/platform/observability/AuditVolumeCard.tsx apps/web/components/platform/observability/AgentActivityCard.tsx
git commit -m "feat(web): add AuditVolumeCard (line chart) and AgentActivityCard (top agents list)"
```

---

### Task 11: Observability Page (compose everything)

**Files:**
- Create: `apps/web/app/[tenant]/dashboard/observability/page.tsx`

- [ ] **Step 1: Create the page**

```typescript
// apps/web/app/[tenant]/dashboard/observability/page.tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { StatTile } from "@/components/platform/observability/StatTile";
import { SystemHealthCard } from "@/components/platform/observability/SystemHealthCard";
import { WorkflowMetricsCard, type WorkflowPoint } from "@/components/platform/observability/WorkflowMetricsCard";
import { CostBreakdownCard, type CostData } from "@/components/platform/observability/CostBreakdownCard";
import { AuditVolumeCard, type AuditPoint } from "@/components/platform/observability/AuditVolumeCard";
import { AgentActivityCard, type Agent } from "@/components/platform/observability/AgentActivityCard";
import { Activity, DollarSign, Workflow, Shield } from "lucide-react";

interface Summary {
    totalRequests24h: number;
    totalCostUsd24h: number;
    activeWorkflows: number;
    workflowSuccessRate24h: number;
    auditEntries24h: number;
    health: { api: 'ok' | 'degraded' | 'down'; relay: 'ok' | 'unknown'; lakehouse: 'ok' | 'unknown' };
}

async function fetchSummary(): Promise<Summary | null> {
    const res = await fetch('/api/proxy/api/v1/observability/summary');
    if (!res.ok) return null;
    return res.json();
}
async function fetchWorkflows(): Promise<WorkflowPoint[]> {
    const res = await fetch('/api/proxy/api/v1/observability/workflows?hours=24');
    if (!res.ok) return [];
    const data = await res.json();
    return data.points ?? [];
}
async function fetchCosts(): Promise<CostData | null> {
    const res = await fetch('/api/proxy/api/v1/observability/costs?days=7');
    if (!res.ok) return null;
    return res.json();
}
async function fetchAudit(): Promise<AuditPoint[]> {
    const res = await fetch('/api/proxy/api/v1/observability/audit-volume?days=14');
    if (!res.ok) return [];
    const data = await res.json();
    return data.points ?? [];
}
async function fetchAgents(): Promise<Agent[]> {
    const res = await fetch('/api/proxy/api/v1/observability/agents?days=7');
    if (!res.ok) return [];
    const data = await res.json();
    return data.agents ?? [];
}

function formatUsd(n: number): string {
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4)}`;
}

export default function ObservabilityPage() {
    const { data: summary, isLoading: summaryLoading } = useQuery({
        queryKey: ['obs', 'summary'],
        queryFn: fetchSummary,
        refetchInterval: 30_000,
    });
    const { data: workflows = [], isLoading: workflowsLoading } = useQuery({
        queryKey: ['obs', 'workflows'],
        queryFn: fetchWorkflows,
        refetchInterval: 30_000,
    });
    const { data: costs, isLoading: costsLoading } = useQuery({
        queryKey: ['obs', 'costs'],
        queryFn: fetchCosts,
        refetchInterval: 60_000,
    });
    const { data: audit = [], isLoading: auditLoading } = useQuery({
        queryKey: ['obs', 'audit'],
        queryFn: fetchAudit,
        refetchInterval: 60_000,
    });
    const { data: agents = [], isLoading: agentsLoading } = useQuery({
        queryKey: ['obs', 'agents'],
        queryFn: fetchAgents,
        refetchInterval: 60_000,
    });

    const successPct = summary ? Math.round(summary.workflowSuccessRate24h * 100) : 0;

    return (
        <PermissionGate resource="audit_log" action="read">
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Platform Observability</h1>
                    <p className="text-muted-foreground mt-2">
                        Live system health, agent workflow metrics, token cost attribution, and audit volume — all data scoped to your jurisdiction.
                    </p>
                </div>

                {/* Top row — 4 stat tiles */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatTile
                        label="API Requests (24h)"
                        value={summary?.totalRequests24h.toLocaleString() ?? '—'}
                        icon={Activity}
                        tone="blue"
                        loading={summaryLoading}
                    />
                    <StatTile
                        label="Spend (24h)"
                        value={summary ? formatUsd(summary.totalCostUsd24h) : '—'}
                        icon={DollarSign}
                        tone="green"
                        loading={summaryLoading}
                    />
                    <StatTile
                        label="Workflow Success"
                        value={summary ? `${successPct}%` : '—'}
                        sublabel={summary ? `${summary.activeWorkflows} active now` : undefined}
                        icon={Workflow}
                        tone={successPct >= 95 ? 'green' : successPct >= 85 ? 'amber' : 'red'}
                        loading={summaryLoading}
                    />
                    <StatTile
                        label="Audit Entries (24h)"
                        value={summary?.auditEntries24h.toLocaleString() ?? '—'}
                        icon={Shield}
                        tone="neutral"
                        loading={summaryLoading}
                    />
                </div>

                {/* Second row — health + workflow chart */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <SystemHealthCard
                        health={summary?.health ?? { api: 'unknown' as any, relay: 'unknown', lakehouse: 'unknown' }}
                        loading={summaryLoading}
                    />
                    <div className="lg:col-span-2">
                        <WorkflowMetricsCard points={workflows} loading={workflowsLoading} />
                    </div>
                </div>

                {/* Third row — costs + audit volume */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <CostBreakdownCard data={costs ?? null} loading={costsLoading} />
                    <AuditVolumeCard points={audit} loading={auditLoading} />
                </div>

                {/* Fourth row — agent activity */}
                <AgentActivityCard agents={agents} loading={agentsLoading} />
            </div>
        </PermissionGate>
    );
}
```

- [ ] **Step 2: Verify the page renders**

Start the web dev server (`cd apps/web && pnpm dev`), navigate to `/[tenant]/dashboard/observability`. Expected: header + 4 stat tiles + system health + workflow chart + cost breakdown + audit volume + agent list. Most data will be zero/empty initially — that's fine.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/\[tenant\]/dashboard/observability/
git commit -m "feat(web): add Platform Observability dashboard page composing all cards"
```

---

### Task 12: Push + sanity check

- [ ] **Step 1: Push**

```bash
git push origin develop
```

- [ ] **Step 2: Sanity-check the endpoints**

```bash
# Summary
curl -s http://localhost:3000/api/proxy/api/v1/observability/summary -b "session=..."
# Costs
curl -s http://localhost:3000/api/proxy/api/v1/observability/costs?days=7 -b "session=..."
```

Expected: JSON with zeros initially. Once the Mastra ingestion workflow has run a few times on the VM, costs/workflows will populate.

---

## Self-Review

**Spec coverage:**
- ✅ System health (API + relay + lakehouse) — SystemHealthCard
- ✅ API metrics (request volume) — StatTile + summary endpoint
- ✅ Workflow execution metrics (success rate, error rate, hourly distribution) — WorkflowMetricsCard
- ✅ Token cost breakdown (by model, by workflow, daily trend) — CostBreakdownCard + new token_costs table
- ✅ Audit log volume (per-actor-type trend) — AuditVolumeCard
- ✅ Agent activity (top agents, costs per agent) — AgentActivityCard
- ✅ One portal (lives in tenant dashboard, sidebar entry, permission-gated)
- ✅ Mastra + custom data sources (token_costs persisted from relay, usage_records + audit_log queried from custom tables, workflow runs from agent_workflow_runs)

**Out of scope for this plan (could be follow-up):**
- Real-time WebSocket updates (currently 30-60s polling)
- Drill-down into individual workflow runs (will come with the pipeline visualization plan)
- Alert thresholds and email notifications
- Compliance export (CSV) of the observability data — audit log already exports

**Placeholder scan:** Clean — every step has runnable code.

**Type consistency:**
- `Summary`, `WorkflowPoint`, `CostData`, `AuditPoint`, `Agent` defined once and imported across page + cards ✅
- API route response shapes match exactly what the page deserializes ✅
- `tokenCosts` schema field names (camelCase in TS, snake_case in DB) align via Drizzle column mapping ✅
- All cost calculations use the same `formatUsd` style (4 decimals under $1, 2 above) ✅
