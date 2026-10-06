// Daily trace retention for Mastra's v-next Postgres observability domain.
//
// Mastra ships this natively: `@mastra/pg`'s ObservabilityStoragePostgresVNext
// (the store wired in memory.ts's getMastraStore(), schemaName 'mastra') implements
// `prune()` for the exact table that filled Supabase — mastra.mastra_span_events.
// Declare a per-table `maxAge` retention policy and call `storage.prune()`; for this
// store the signal tables are day-partitioned, so prune() drops whole child
// partitions of mastra_span_events (DETACH + DROP) instead of deleting rows. See
// node_modules/@mastra/core/dist/docs/references/reference-storage-retention.md and
// node_modules/@mastra/pg/dist/storage/domains/observability/v-next/retention.d.ts.
//
// There is no hand-rolled partition listing, regex validation, or raw SQL here —
// the task brief's fallback plan (read pg_inherits, validate
// `^mastra_span_events_p\d{8}$`, drop by hand) is only needed when no native option
// exists. It does exist, and @mastra/pg's own implementation already guarantees:
// only child partitions of mastra.mastra_span_events are touched, and only whole
// partitions wholly older than the cutoff are dropped (so "last 3 days" and future
// partitions are never eligible). That guarantee lives in @mastra/pg, not here, so it
// isn't re-tested by this package's suite (this package never runs SQL in tests).
//
// This module only decides HOW OFTEN prune() runs and WITH WHAT maxAge (from
// TRACE_RETENTION_DAYS), and makes sure a prune failure is logged, never thrown — a
// trace-cleanup bug must never crash the orchestrator process.

import type { PruneResult } from '@mastra/core/storage'

export const DEFAULT_TRACE_RETENTION_DAYS = 3
export const MIN_TRACE_RETENTION_DAYS = 2
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** The slice of PostgresStoreVNext this module depends on. */
export interface PrunableStore {
  prune(options?: { retention?: Record<string, unknown> }): Promise<PruneResult[]>
}

export interface RetentionLogger {
  log: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * Pure: resolves TRACE_RETENTION_DAYS from the given env map.
 * - Unset, blank, or non-numeric → default (3).
 * - Numeric but below the minimum (2) → clamped up to the minimum.
 * - Fractional values are floored first, then clamped.
 */
export function resolveTraceRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TRACE_RETENTION_DAYS
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRACE_RETENTION_DAYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_TRACE_RETENTION_DAYS
  return Math.max(Math.floor(parsed), MIN_TRACE_RETENTION_DAYS)
}

/**
 * One retention pass against the mastra_span_events partitions. Delegates the
 * actual drop to the store's native prune(); this function's only job is
 * wiring the maxAge and making sure a failure never propagates — it is
 * logged and swallowed, not thrown.
 */
export async function runTraceRetentionPrune(
  store: PrunableStore,
  days: number,
  logger: RetentionLogger = console,
): Promise<void> {
  try {
    const results = await store.prune({
      retention: { observability: { spans: { maxAge: `${days}d` } } },
    })
    for (const r of results) {
      logger.log(
        `[trace-retention] ${r.domain}.${r.table}: deleted ${r.deleted} row(s)` +
          (r.done ? '' : ' (more remain, will continue on the next tick)'),
      )
    }
  } catch (err) {
    logger.error('[trace-retention] prune failed:', (err as Error).message)
  }
}

/**
 * Wires a daily tick: one pass shortly after startup (so a long-running
 * process doesn't wait a full day for its first prune), then every 24h.
 * Returns the interval handle so callers/tests can clear it.
 */
export function scheduleTraceRetention(
  store: PrunableStore,
  days: number = resolveTraceRetentionDays(),
  logger: RetentionLogger = console,
): NodeJS.Timeout {
  void runTraceRetentionPrune(store, days, logger)
  return setInterval(() => {
    void runTraceRetentionPrune(store, days, logger)
  }, ONE_DAY_MS)
}
