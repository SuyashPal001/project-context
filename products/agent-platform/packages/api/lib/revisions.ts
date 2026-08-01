export type RevisionActorType = 'human' | 'agent';

/**
 * The fields that carry intent. A change to any of these is worth recording;
 * status, sort order, assignee and the rest are workflow bookkeeping and are
 * already covered by task_events.
 */
export const TRACKED_FIELDS = [
  'title',
  'description',
  'acceptanceCriteria',
  'estimatedHours',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface RevisionMeta {
  taskId: string;
  tenantId: string;
  actorType: RevisionActorType;
  actorId: string;
}

export interface TaskRevisionRow {
  taskId: string;
  tenantId: string;
  field: TrackedField;
  originalContent: unknown;
  correctedContent: unknown;
  wasEdited: boolean;
  actorType: RevisionActorType;
  actorId: string;
}

/** Recursively sort object keys so comparison is independent of key order.
 *  Postgres jsonb does not preserve key order on round-trip, so a value read
 *  back from the database can serialize differently from an equivalent value
 *  sent by a client. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function isUnchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * Compare a validated patch against the task as it stands and return one
 * revision row per tracked field that actually changed. Returns [] when
 * nothing tracked changed, so callers can skip the insert entirely.
 */
export function buildTaskRevisions(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  meta: RevisionMeta,
): TaskRevisionRow[] {
  const rows: TaskRevisionRow[] = [];

  for (const field of TRACKED_FIELDS) {
    if (!(field in patch)) continue;

    const originalContent = before[field] ?? null;
    const correctedContent = patch[field] ?? null;
    if (isUnchanged(originalContent, correctedContent)) continue;

    rows.push({
      taskId: meta.taskId,
      tenantId: meta.tenantId,
      field,
      originalContent,
      correctedContent,
      wasEdited: meta.actorType === 'human',
      actorType: meta.actorType,
      actorId: meta.actorId,
    });
  }

  return rows;
}
