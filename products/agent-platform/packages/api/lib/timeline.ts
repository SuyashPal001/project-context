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
 * Comparator for TimelineRow sorting. Exported for testing the total order property.
 */
export function compareTimelineRows(a: TimelineRow, b: TimelineRow): number {
  // Origin always leads. On backfilled tasks raw_input was copied from
  // description, so its timestamp is the task's creation time and cannot be
  // trusted to precede the rows it conceptually comes before.
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
}

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

  return rows.sort(compareTimelineRows);
}
