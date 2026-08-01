# Task Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a task's intent diff — the original ask, what the AI drafted, what a human changed, what was approved — as one chronological feed in the existing Timeline tab.

**Architecture:** A pure `mergeTimeline` function in the API package turns three data sources into one sorted `TimelineRow[]`. It has no React, no database, and no fetch, so the handover pack generator can call it server-side later. A new `GET /tasks/:taskId/timeline` endpoint **calls it and returns finished rows**; the web layer fetches via a hook matching the existing `useTaskComments` pattern and dispatches each row to a renderer.

**Why the merge is server-side:** `apps/web` has zero `@serverless-saas/*` dependencies — it is HTTP-only by design. Merging in the endpoint keeps the ordering logic in one tested place without wiring the web app into the workspace (`transpilePackages`, deploy build ordering, its first workspace dependency). The web layer renders what it is given.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vitest, Next.js App Router, TanStack Query, Tailwind, lucide-react.

## Global Constraints

- Package scope is `@serverless-saas/*`. Every query filters by `tenantId` read from `requestContext`.
- Tests are pure-unit with `vi.mock` hoisted above imports and never touch a database. Run from `products/agent-platform/packages/api` with `pnpm vitest run <path>`.
- Web components in this repo have no tests. Do not add a test harness for them.
- API route files use 4-space indentation; web components use 4-space. Match the file you edit.
- Comments stay in `ThreadTab` and must not appear in the timeline. This repo separates conversation from audit.
- Do not modify `apps/api/src/app.ts` or any middleware.
- No database migration in this plan. All columns already exist.
- The full suite is 45/45 before this plan starts.

---

### Task 1: `mergeTimeline` pure function

**Files:**
- Create: `products/agent-platform/packages/api/lib/timeline.ts`
- Test: `products/agent-platform/packages/api/__tests__/timeline.test.ts`

**Interfaces:**
- Consumes: `TrackedField` and `RevisionActorType` from `./revisions` (both already exported at `lib/revisions.ts:1,15`).
- Produces: `TimelineRow` (discriminated union), `TimelineInput`, `TimelineRevision`, `TimelineEvent`, and `mergeTimeline(input: TimelineInput): TimelineRow[]`.

- [ ] **Step 1: Write the failing test**

Create `products/agent-platform/packages/api/__tests__/timeline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mergeTimeline } from '../lib/timeline'

const rev = (id: string, at: string, field = 'title') => ({
  id,
  field: field as 'title' | 'description' | 'acceptanceCriteria' | 'estimatedHours',
  originalContent: 'before',
  correctedContent: 'after',
  actorType: 'human' as const,
  actorName: 'Priya',
  createdAt: at,
})

const evt = (id: string, at: string, eventType = 'plan_approved') => ({
  id,
  eventType,
  actorType: 'human' as const,
  actorName: 'Priya',
  payload: {},
  createdAt: at,
})

describe('mergeTimeline', () => {
  it('returns an empty feed when there is nothing to show', () => {
    expect(mergeTimeline({ rawInput: null, revisions: [], events: [] })).toEqual([])
  })

  it('emits an origin row when rawInput is present', () => {
    const rows = mergeTimeline({ rawInput: 'log in with Google', revisions: [], events: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'origin', content: 'log in with Google' })
  })

  it('emits no origin row for a legacy task with no rawInput', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', '2026-08-01T10:00:00Z')],
      events: [],
    })
    expect(rows.every((r) => r.kind !== 'origin')).toBe(true)
  })

  it('sorts ascending by timestamp', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r2', '2026-08-01T12:00:00Z')],
      events: [evt('e1', '2026-08-01T10:00:00Z')],
    })
    expect(rows.map((r) => 'id' in r && r.id)).toEqual(['e1', 'r2'])
  })

  it('pins origin first even when its timestamp is later than every other row', () => {
    const rows = mergeTimeline({
      rawInput: 'the original ask',
      originAt: '2026-08-01T23:00:00Z',
      revisions: [rev('r1', '2026-08-01T10:00:00Z')],
      events: [evt('e1', '2026-08-01T09:00:00Z')],
    })
    expect(rows[0].kind).toBe('origin')
    expect(rows.map((r) => 'id' in r && r.id)).toEqual([false, 'e1', 'r1'])
  })

  it('breaks timestamp ties as event before revision', () => {
    const at = '2026-08-01T10:00:00Z'
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', at)],
      events: [evt('e1', at)],
    })
    expect(rows.map((r) => 'id' in r && r.id)).toEqual(['e1', 'r1'])
  })

  it('breaks ties within the same kind by id, so the order is stable across renders', () => {
    const at = '2026-08-01T10:00:00Z'
    const forward = mergeTimeline({
      rawInput: null,
      revisions: [rev('r-b', at), rev('r-a', at)],
      events: [],
    })
    const reversed = mergeTimeline({
      rawInput: null,
      revisions: [rev('r-a', at), rev('r-b', at)],
      events: [],
    })
    expect(forward.map((r) => 'id' in r && r.id)).toEqual(['r-a', 'r-b'])
    expect(reversed.map((r) => 'id' in r && r.id)).toEqual(['r-a', 'r-b'])
  })

  it('carries revision fields through to the row', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', '2026-08-01T10:00:00Z', 'estimatedHours')],
      events: [],
    })
    expect(rows[0]).toMatchObject({
      kind: 'revision',
      field: 'estimatedHours',
      originalContent: 'before',
      correctedContent: 'after',
      actorType: 'human',
      actorName: 'Priya',
    })
  })

  it('passes an unknown event type through rather than throwing', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [],
      events: [evt('e1', '2026-08-01T10:00:00Z', 'something_new')],
    })
    expect(rows[0]).toMatchObject({ kind: 'event', eventType: 'something_new' })
  })

  it('does not mutate its input arrays', () => {
    const revisions = [rev('r2', '2026-08-01T12:00:00Z'), rev('r1', '2026-08-01T10:00:00Z')]
    const events = [evt('e1', '2026-08-01T11:00:00Z')]
    mergeTimeline({ rawInput: null, revisions, events })
    expect(revisions.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(events.map((e) => e.id)).toEqual(['e1'])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/timeline.test.ts
```

Expected: FAIL — `Cannot find module '../lib/timeline'`.

- [ ] **Step 3: Implement `mergeTimeline`**

Create `products/agent-platform/packages/api/lib/timeline.ts`:

```typescript
import type { RevisionActorType, TrackedField } from './revisions';

export interface TimelineRevision {
  id: string;
  field: TrackedField;
  originalContent: unknown;
  correctedContent: unknown;
  actorType: RevisionActorType;
  actorName?: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  eventType: string;
  actorType: 'agent' | 'human' | 'system';
  actorName?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface TimelineInput {
  /** The original ask. Null on tasks created before provenance was recorded. */
  rawInput: string | null;
  /** Task creation time, used only for display on the origin row. */
  originAt?: string;
  revisions: TimelineRevision[];
  events: TimelineEvent[];
}

export type TimelineRow =
  | { kind: 'origin'; at: string; content: string }
  | {
      kind: 'revision';
      at: string;
      id: string;
      field: TrackedField;
      originalContent: unknown;
      correctedContent: unknown;
      actorType: RevisionActorType;
      actorName?: string;
    }
  | {
      kind: 'event';
      at: string;
      id: string;
      eventType: string;
      actorType: 'agent' | 'human' | 'system';
      actorName?: string;
      payload?: Record<string, unknown>;
    };

// Tie-break order for rows sharing a timestamp. One PATCH writes several
// revisions with an identical created_at, so without a deterministic order the
// feed silently reshuffles between renders.
const KIND_RANK: Record<TimelineRow['kind'], number> = {
  origin: 0,
  event: 1,
  revision: 2,
};

/**
 * Merge the three provenance sources into one chronological feed.
 *
 * Pure: no React, no database, no fetch. The handover pack generator calls this
 * server-side to emit HTML without mounting a component.
 */
export function mergeTimeline(input: TimelineInput): TimelineRow[] {
  const rows: TimelineRow[] = [];

  if (input.rawInput !== null && input.rawInput !== undefined) {
    rows.push({
      kind: 'origin',
      at: input.originAt ?? '',
      content: input.rawInput,
    });
  }

  for (const e of input.events) {
    rows.push({
      kind: 'event',
      at: e.createdAt,
      id: e.id,
      eventType: e.eventType,
      actorType: e.actorType,
      actorName: e.actorName,
      payload: e.payload,
    });
  }

  for (const r of input.revisions) {
    rows.push({
      kind: 'revision',
      at: r.createdAt,
      id: r.id,
      field: r.field,
      originalContent: r.originalContent,
      correctedContent: r.correctedContent,
      actorType: r.actorType,
      actorName: r.actorName,
    });
  }

  return rows.sort((a, b) => {
    // Origin always leads. On backfilled tasks raw_input was copied from
    // description, so its timestamp is the task's creation time and cannot be
    // trusted to precede the rows it conceptually comes before.
    // The both-origin case must come first: without it, cmp(a,b) and cmp(b,a)
    // would both return -1, and an inconsistent comparator makes
    // Array.prototype.sort engine-dependent.
    if (a.kind === 'origin' && b.kind === 'origin') return 0;
    if (a.kind === 'origin') return -1;
    if (b.kind === 'origin') return 1;

    // Lexicographic comparison is correct for ISO 8601 only while every value
    // shares one format. These all originate from Postgres timestamp columns
    // serialized to JSON with a trailing Z, so the precondition holds.
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
      return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    }
    const aId = 'id' in a ? a.id : '';
    const bId = 'id' in b ? b.id : '';
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
```

Two subtleties are in the comparator rather than the prose, deliberately: the
both-origin guard keeps the comparator a valid total order (without it,
`cmp(a,b)` and `cmp(b,a)` both return `-1`, making `sort` engine-dependent), and
the ISO-string comparison is only sound while every timestamp shares one format.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/timeline.test.ts
```

Expected: PASS — 10 tests.

- [ ] **Step 5: Run the full package suite**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
```

Expected: PASS — 55/55 (45 before, 10 new).

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/lib/timeline.ts \
        products/agent-platform/packages/api/__tests__/timeline.test.ts
git commit -m "feat(timeline): add mergeTimeline pure function"
```

---

### Task 2: `GET /tasks/:taskId/timeline` endpoint

**Files:**
- Create: `products/agent-platform/packages/api/routes/tasks.timeline.ts`
- Modify: `products/agent-platform/packages/api/routes/tasks.ts`

**Interfaces:**
- Consumes: `mergeTimeline`, `TimelineRevision`, and `TimelineEvent` from Task 1's `lib/timeline.ts`.
- Produces: `handleGetTimeline(c: Context<AppEnv>)`, mounted at `GET /tasks/:taskId/timeline`. Response body: `{ data: TimelineRow[] }` — **already merged and sorted**. The web layer renders the array as-is.

- [ ] **Step 1: Write the handler**

Create `products/agent-platform/packages/api/routes/tasks.timeline.ts`:

```typescript
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentTasks, taskEvents } from '@serverless-saas/agent-schema/agents';
import { taskRevisions } from '@serverless-saas/agent-schema/task-revisions';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { mergeTimeline } from '../lib/timeline';
import type { TimelineRevision } from '../lib/timeline';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// GET /tasks/:taskId/timeline — provenance feed for one task.
// Merges server-side and returns finished rows: apps/web is HTTP-only (no
// workspace dependencies), so keeping the ordering logic here means it exists
// and is tested in exactly one place.
export async function handleGetTimeline(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const taskId = c.req.param('taskId') as string;

    const task = (await db.select({
        id: agentTasks.id,
        rawInput: agentTasks.rawInput,
        createdAt: agentTasks.createdAt,
    }).from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const revisionRows = await db.select({
        id: taskRevisions.id,
        field: taskRevisions.field,
        originalContent: taskRevisions.originalContent,
        correctedContent: taskRevisions.correctedContent,
        actorType: taskRevisions.actorType,
        actorName: users.name,
        createdAt: taskRevisions.createdAt,
    })
        .from(taskRevisions)
        .leftJoin(users, eq(taskRevisions.actorId, users.id))
        .where(and(
            eq(taskRevisions.taskId, taskId),
            eq(taskRevisions.tenantId, tenantId),
        ))
        .orderBy(asc(taskRevisions.createdAt));

    const eventRows = await db.select({
        id: taskEvents.id,
        eventType: taskEvents.eventType,
        actorType: taskEvents.actorType,
        payload: taskEvents.payload,
        createdAt: taskEvents.createdAt,
    })
        .from(taskEvents)
        .where(and(
            eq(taskEvents.taskId, taskId),
            eq(taskEvents.tenantId, tenantId),
        ))
        .orderBy(asc(taskEvents.createdAt));

    const rows = mergeTimeline({
        rawInput: task.rawInput,
        originAt: task.createdAt.toISOString(),
        revisions: revisionRows.map(r => ({
            id: r.id,
            field: r.field as TimelineRevision['field'],
            originalContent: r.originalContent,
            correctedContent: r.correctedContent,
            actorType: r.actorType,
            actorName: r.actorName ?? undefined,
            createdAt: r.createdAt.toISOString(),
        })),
        events: eventRows.map(e => ({
            id: e.id,
            eventType: e.eventType,
            actorType: e.actorType,
            payload: (e.payload ?? undefined) as Record<string, unknown> | undefined,
            createdAt: e.createdAt.toISOString(),
        })),
    });

    return c.json({ data: rows });
}
```

`taskEvents.actorId` is `text`, not a `uuid` foreign key to `users` (see
`agents.ts:166`), so events carry no joined actor name. The renderer falls back
to the actor type, which is what the current `TimelineTab` already does.

`users.name` is `text('name').notNull()` at
`packages/foundation/database/schema/auth.ts:9` — already verified, no lookup
needed.

- [ ] **Step 2: Register the route**

In `products/agent-platform/packages/api/routes/tasks.ts`, add the import
alongside the existing handler imports:

```typescript
import { handleGetTimeline } from './tasks.timeline';
```

Then register it next to the other `/:taskId/*` routes, after the
`tasksRoutes.patch('/:taskId', handleUpdateTask);` line:

```typescript
tasksRoutes.get('/:taskId/timeline', handleGetTimeline);
```

It must be registered after the `/bulk` routes, which the file's existing
comment explains are declared first to avoid `/:taskId` shadowing them.

- [ ] **Step 3: Type-check**

```bash
cd products/agent-platform/packages/api && pnpm type-check
```

Expected: PASS.

- [ ] **Step 4: Confirm nothing regressed**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
```

Expected: PASS — 55/55.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/tasks.timeline.ts \
        products/agent-platform/packages/api/routes/tasks.ts
git commit -m "feat(timeline): add GET /tasks/:taskId/timeline endpoint"
```

---

### Task 3: Timeline UI

**Files:**
- Create: `apps/web/components/platform/task-detail/useTaskTimeline.ts`
- Create: `apps/web/components/platform/task-detail/timeline/rows.tsx`
- Create: `apps/web/components/platform/task-detail/timeline/fields.tsx`
- Modify: `apps/web/components/platform/task-detail/TimelineTab.tsx` (full rewrite)
- Modify: `apps/web/components/platform/task-detail/ActivityFeed.tsx:5,13,16,56`
- Modify: `apps/web/components/platform/task-detail/TaskMainContent.tsx:317`
- Modify: `apps/web/types/task.ts`

**Interfaces:**
- Consumes: the endpoint from Task 2 and the `TimelineRow` union from Task 1. The web layer redeclares the types rather than importing across the workspace boundary, matching how `apps/web/types/task.ts` already redeclares `TaskEvent` and `TaskComment`.
- Produces: no exports other tasks depend on. This is the last task.

- [ ] **Step 1: Add the web types**

Append to `apps/web/types/task.ts`:

```typescript
export type TimelineTrackedField =
    | 'title'
    | 'description'
    | 'acceptanceCriteria'
    | 'estimatedHours'

export type TimelineRow =
    | { kind: 'origin'; at: string; content: string }
    | {
        kind: 'revision'
        at: string
        id: string
        field: TimelineTrackedField
        originalContent: unknown
        correctedContent: unknown
        actorType: 'human' | 'agent'
        actorName?: string | null
    }
    | {
        kind: 'event'
        at: string
        id: string
        eventType: string
        actorType: 'agent' | 'human' | 'system'
        actorName?: string | null
        payload?: Record<string, any>
    }

export type TimelineResponse = {
    data: TimelineRow[]
}
```

The endpoint merges and sorts server-side, so the web layer receives finished
rows and renders them in order.

- [ ] **Step 2: Add the fetching hook**

Create `apps/web/components/platform/task-detail/useTaskTimeline.ts`, matching
the shape of the sibling `useTaskComments.ts`:

```typescript
'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { TimelineResponse } from '@/types/task'

export function useTaskTimeline(taskId: string) {
    const query = useQuery<TimelineResponse>({
        queryKey: ['task-timeline', taskId],
        queryFn: () => api.get<TimelineResponse>(`/api/v1/tasks/${taskId}/timeline`),
    })

    return {
        rows: query.data?.data ?? [],
        isLoading: query.isLoading,
    }
}
```

- [ ] **Step 3: Add the per-field renderers**

Create `apps/web/components/platform/task-detail/timeline/fields.tsx`:

```tsx
'use client'

import { useState } from 'react'
import type { TimelineTrackedField } from '@/types/task'

const FIELD_LABELS: Record<TimelineTrackedField, string> = {
    title: 'title',
    description: 'description',
    acceptanceCriteria: 'acceptance criteria',
    estimatedHours: 'estimate',
}

function asText(value: unknown): string {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'string') return value
    return JSON.stringify(value)
}

function InlineChange({ field, from, to }: { field: TimelineTrackedField; from: unknown; to: unknown }) {
    return (
        <span className="text-xs text-muted-foreground/60">
            {FIELD_LABELS[field]}:{' '}
            <span className="line-through opacity-50">{asText(from)}</span>
            {' → '}
            <span className="text-foreground/80">{asText(to)}</span>
        </span>
    )
}

function CriteriaChange({ from, to }: { from: unknown; to: unknown }) {
    const list = (v: unknown): string[] =>
        Array.isArray(v) ? v.map((i) => (i && typeof i === 'object' && 'text' in i ? String((i as any).text) : String(i))) : []
    const before = list(from)
    const after = list(to)
    const added = after.filter((t) => !before.includes(t))
    const removed = before.filter((t) => !after.includes(t))

    return (
        <div className="text-xs text-muted-foreground/60">
            changed acceptance criteria
            <div className="mt-1 space-y-0.5">
                {added.map((t) => <div key={`+${t}`} className="text-emerald-500/70">+ {t}</div>)}
                {removed.map((t) => <div key={`-${t}`} className="text-red-500/70 line-through">− {t}</div>)}
            </div>
        </div>
    )
}

function DescriptionChange({ from, to }: { from: unknown; to: unknown }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="text-xs text-muted-foreground/60">
            rewrote the description{' '}
            <button
                onClick={() => setOpen((o) => !o)}
                className="text-primary/70 hover:text-primary transition-colors"
            >
                {open ? 'hide diff' : 'show diff'}
            </button>
            {open && (
                <div className="mt-2 space-y-2">
                    <div>
                        <div className="text-[10px] uppercase tracking-wide opacity-40 mb-0.5">before</div>
                        <div className="rounded border border-[#1e1e1e] p-2 whitespace-pre-wrap opacity-60">{asText(from)}</div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase tracking-wide opacity-40 mb-0.5">after</div>
                        <div className="rounded border border-[#1e1e1e] p-2 whitespace-pre-wrap text-foreground/80">{asText(to)}</div>
                    </div>
                </div>
            )}
        </div>
    )
}

export function FieldChange({ field, from, to }: { field: TimelineTrackedField; from: unknown; to: unknown }) {
    if (field === 'description') return <DescriptionChange from={from} to={to} />
    if (field === 'acceptanceCriteria') return <CriteriaChange from={from} to={to} />
    return <InlineChange field={field} from={from} to={to} />
}
```

- [ ] **Step 4: Add the row renderers**

Create `apps/web/components/platform/task-detail/timeline/rows.tsx`:

```tsx
'use client'

import {
    Bot, User, Settings, MessageSquare, Check, CheckCircle, XCircle, RefreshCw, Quote, Pencil,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import type { TimelineRow } from '@/types/task'
import { formatRelativeTime } from '../_sidebarHelpers'
import { FieldChange } from './fields'

type IconComponent = ComponentType<{ className?: string }>

const ACTOR_ICONS: Record<'agent' | 'human' | 'system', IconComponent> = {
    agent: Bot,
    human: User,
    system: Settings,
}

const ACTOR_NAMES: Record<'agent' | 'human' | 'system', string> = {
    agent: 'Agent',
    human: 'You',
    system: 'System',
}

const EVENT_OVERRIDES: Record<string, { icon: IconComponent; label: (payload?: Record<string, any>) => string }> = {
    status_changed: { icon: RefreshCw, label: (p) => `Status → ${p?.to || 'unknown'}` },
    comment_added: { icon: MessageSquare, label: () => 'Added a comment' },
    plan_proposed: { icon: RefreshCw, label: () => 'Proposed an execution plan' },
    plan_approved: { icon: CheckCircle, label: () => 'Approved the execution plan' },
    plan_rejected: { icon: XCircle, label: () => 'Requested changes to the plan' },
    clarification_requested: { icon: MessageSquare, label: () => 'Requested clarification' },
    clarification_answered: { icon: Check, label: () => 'Provided clarification' },
}

function Shell({ icon: Icon, accent, children, at }: {
    icon: IconComponent
    accent: boolean
    children: React.ReactNode
    at?: string
}) {
    return (
        <div className="relative pl-9">
            <div className="absolute left-1 top-0.5 w-4 h-4 rounded-full bg-[#0f0f0f] border border-[#1e1e1e] flex items-center justify-center z-10">
                <Icon className={cn('w-2.5 h-2.5', accent ? 'text-primary' : 'text-muted-foreground')} />
            </div>
            <div className="flex items-start gap-2">
                {children}
                {at ? (
                    <span className="text-[11px] text-muted-foreground/30 ml-auto shrink-0">
                        {formatRelativeTime(at)}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

export function TimelineRowItem({ row }: { row: TimelineRow }) {
    if (row.kind === 'origin') {
        return (
            <Shell icon={Quote} accent>
                <div>
                    <div className="text-[10px] uppercase tracking-wide text-primary/60 mb-0.5">Original ask</div>
                    <div className="text-xs text-foreground/80 whitespace-pre-wrap">{row.content}</div>
                </div>
            </Shell>
        )
    }

    if (row.kind === 'revision') {
        return (
            <Shell icon={Pencil} accent={row.actorType === 'agent'} at={row.at}>
                <span className="text-xs text-foreground/80 font-medium shrink-0">
                    {row.actorName || ACTOR_NAMES[row.actorType]}
                </span>
                <FieldChange field={row.field} from={row.originalContent} to={row.correctedContent} />
            </Shell>
        )
    }

    const override = EVENT_OVERRIDES[row.eventType]
    const Icon = override?.icon ?? ACTOR_ICONS[row.actorType]
    const label = override?.label(row.payload) ?? row.eventType.replace(/_/g, ' ')

    return (
        <Shell icon={Icon} accent={row.actorType === 'agent'} at={row.at}>
            <span className="text-xs text-foreground/80 font-medium shrink-0">
                {row.actorName || ACTOR_NAMES[row.actorType]}
            </span>
            <span className="text-xs text-muted-foreground/60">{label}</span>
        </Shell>
    )
}
```

- [ ] **Step 5: Rewrite `TimelineTab`**

Replace the entire contents of
`apps/web/components/platform/task-detail/TimelineTab.tsx`:

```tsx
'use client'

import { useTaskTimeline } from './useTaskTimeline'
import { TimelineRowItem } from './timeline/rows'

export function TimelineTab({ taskId }: { taskId: string }) {
    const { rows, isLoading } = useTaskTimeline(taskId)

    if (isLoading) {
        return <p className="text-sm text-muted-foreground/40 italic py-4">Loading timeline…</p>
    }
    if (rows.length === 0) {
        return <p className="text-sm text-muted-foreground/40 italic py-4">No events yet.</p>
    }

    return (
        <div className="space-y-4 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[#1e1e1e] ml-1">
            {rows.map(row => (
                <TimelineRowItem key={row.kind === 'origin' ? 'origin' : row.id} row={row} />
            ))}
        </div>
    )
}
```

- [ ] **Step 6: Update the call site and drop the now-dead prop**

`events` appears exactly three times in
`apps/web/components/platform/task-detail/ActivityFeed.tsx` — the interface
(line 13), the destructure (line 16), and the `TimelineTab` render (line 56) —
and `TimelineTab` was its only consumer. Once the tab fetches its own data the
prop is dead, so remove it rather than leaving it threaded.

Line 56 becomes:

```tsx
{activeTab === 'Timeline' && <TimelineTab taskId={taskId} />}
```

Delete `events: TaskEvent[]` from `ActivityFeedProps` (line 13), change the
signature (line 16) to:

```tsx
export function ActivityFeed({ taskId }: ActivityFeedProps) {
```

and drop the now-unused `TaskEvent` import at line 5 if nothing else in the file
references it.

Then update the single call site in
`apps/web/components/platform/task-detail/TaskMainContent.tsx:317`:

```tsx
<ActivityFeed taskId={taskId} />
```

Leave `events` on `TaskMainContent` itself — `ExecutionConsole` still consumes
it at line 307.

- [ ] **Step 7: Type-check the web app**

```bash
cd apps/web && pnpm type-check
```

Expected: PASS. A failure naming `events` means a call site was missed — there
is only the one, at `TaskMainContent.tsx:317`.

- [ ] **Step 8: Confirm the API suite still passes**

```bash
cd products/agent-platform/packages/api && pnpm vitest run
```

Expected: PASS — 55/55.

- [ ] **Step 9: Commit**

```bash
git add apps/web/types/task.ts \
        apps/web/components/platform/task-detail/useTaskTimeline.ts \
        apps/web/components/platform/task-detail/timeline/rows.tsx \
        apps/web/components/platform/task-detail/timeline/fields.tsx \
        apps/web/components/platform/task-detail/TimelineTab.tsx \
        apps/web/components/platform/task-detail/ActivityFeed.tsx
git commit -m "feat(timeline): render origin, revisions, and events in the timeline tab"
```

---

## On the type redeclaration

`apps/web/types/task.ts` redeclares `TimelineRow` rather than importing it,
matching how it already redeclares `TaskEvent` and `TaskComment`. `apps/web` has
zero `@serverless-saas/*` dependencies — it is HTTP-only by design, and wiring it
into the workspace would mean `transpilePackages`, deploy build ordering, and its
first workspace dependency.

This is a type mirror, not duplicated logic: the merge and sort exist once, in
the API package, and are tested there. If the shapes drift, the API governs and
the failure is a visible render bug rather than a silent ordering difference.

## Verifying by hand

The database has zero tasks, so the timeline will be empty until one exists.
To see it render: create a task, edit its title and estimate, then open the task
and switch to the Timeline tab. The origin row should show the original ask, and
two revision rows should show the before/after values.
