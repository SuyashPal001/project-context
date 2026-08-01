# Task Timeline — Design

**Date:** 2026-08-01
**Status:** Approved, ready for planning
**Parent:** `2026-08-01-agency-handover-design.md` (Track A, item 4)
**Depends on:** Track A items 1–3 — `raw_input`, `task_revisions` (merged, `090883d`)

---

## Goal

Render the intent diff a task accumulated during delivery: what was originally
asked, what the AI drafted, what a human changed, and what was approved — as one
chronological feed.

This is Track A item 4. It is the demo asset and the launch GIF, and it is the
renderer the handover pack will reuse.

---

## Scope

**Per-task, extending the existing component.** `TimelineTab.tsx` already exists
(67 lines) and renders `task_events` with agent/human/system icons on a vertical
connector — already the right visual pattern, just fed too little data.

The per-project roll-up belongs to the handover pack and gets its own spec. It
will mount the same row renderers in a different container.

---

## What it shows

Three sources merged into one feed, oldest first, origin pinned at the top:

```
◆ ORIGIN     Client asked: "users should be able to log in with
             their work Google account"

🤖 Agent     drafted the task                              3h ago
🤖 Agent     proposed an execution plan                    3h ago
✎ You       title: Add auth → Add SSO auth                 2h ago
✎ You       estimate: 4h → 6h                              2h ago
✎ You       rewrote the description        [show diff ▾]   2h ago
✓ You       approved the plan                              1h ago
```

| Row kind | Source | Note |
|---|---|---|
| `origin` | `agent_tasks.raw_input` | Synthetic — not a table row. Absent on legacy tasks. |
| `revision` | `task_revisions` | The diff. `title`, `description`, `acceptanceCriteria`, `estimatedHours`. |
| `event` | `task_events` | 11 existing types incl. `plan_approved`, `clarification_requested`. |

**Comments are excluded.** They live in the existing `ThreadTab`. This codebase
already separates conversation (Thread) from audit (Timeline); Plane merges the
two, but following the established local split is the better call here.

---

## Architecture

One rule drives the structure: **the merge is pure and lives outside React**, so
the handover pack generator can call it server-side to emit HTML without
mounting a component.

```
products/agent-platform/packages/api/lib/timeline.ts
    mergeTimeline(input) → TimelineRow[]
    Pure. No React, no DB, no fetch.

apps/web/components/platform/task-detail/timeline/
    One renderer per row kind. Revision rows dispatch per field.

apps/web/components/platform/task-detail/TimelineTab.tsx
    Container. Receives data, calls merge, maps rows.
```

### The row type

```typescript
export type TimelineRow =
  | { kind: 'origin'; at: string; content: string }
  | { kind: 'revision'; at: string; id: string; field: TrackedField;
      originalContent: unknown; correctedContent: unknown;
      actorType: 'human' | 'agent'; actorName?: string }
  | { kind: 'event'; at: string; id: string; eventType: string;
      actorType: 'agent' | 'human' | 'system'; actorName?: string;
      payload?: Record<string, unknown> };
```

`mergeTimeline` sorts ascending by `at`. The `origin` row sorts first
regardless of timestamp — it represents the ask that preceded every recorded
event, and on backfilled rows its timestamp is unreliable.

**Tie-breaking:** rows sharing a timestamp order `origin` → `event` → `revision`,
then by `id`. One PATCH writes several revisions with identical `created_at`, so
without a deterministic tie-break the feed reorders between renders.

### Per-field rendering

Each tracked field decides its own presentation:

| Field | Presentation |
|---|---|
| `title` | Inline: `old → new` |
| `estimatedHours` | Inline: `4h → 6h` |
| `acceptanceCriteria` | Checklist diff: `+ added`, `− removed` |
| `description` | Collapsed summary, expandable to full before/after |

Collapsed-vs-expanded is a styling choice, reversible in an afternoon. The
architectural commitment is the dispatch, not the presentation.

---

## Data flow

New endpoint: `GET /tasks/:taskId/timeline`

Returns `{ rawInput, revisions, events }` — three arrays plus the origin string.
The client calls `mergeTimeline` on the response.

Tenant-scoped exactly like the sibling task routes: read `tenantId` from
`requestContext`, verify the task belongs to it, return 404 otherwise. Requires
`agent_tasks:read`.

The alternative was a SQL `UNION ALL` merging server-side. Rejected: ordering
and tie-breaking then live in a query that cannot be unit-tested, and the
handover pack would need the same logic a second time.

---

## Testing

`mergeTimeline` is pure, so it gets real tests in
`products/agent-platform/packages/api/__tests__/timeline.test.ts`, matching the
`vi.mock`-based pattern used by `revisions.test.ts` and `branding.test.ts`:

- ascending order by `at`
- `origin` sorts first even when its timestamp is later than other rows
- deterministic tie-break when timestamps are identical
- absent `raw_input` (legacy tasks) yields no origin row
- empty revisions, empty events, and both empty
- unknown `eventType` passes through rather than throwing

Renderers get no tests, consistent with this repo.

---

## Not doing

Filtering, sort controls, pagination, and real-time push. Plane has all four.
The database currently holds zero tasks; add them when a feed is long enough to
be annoying.

---

## What this leaves for the handover pack

The pack's own spec will cover `handover_packs`, the generator, the signed
client link, and the ownership section. It reuses `mergeTimeline` server-side
and the row renderers for display. Nothing in this design needs to change for
that to work — which is the reason the merge is pure.
