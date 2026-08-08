/**
 * Scheduling long notification-workflow delays over SQS.
 *
 * SQS accepts a maximum DelaySeconds of 900. The previous code treated anything
 * longer as unschedulable: it wrote a notificationJobs row with status
 * 'pending' and logged "EventBridge pickup not yet implemented". Nothing ever
 * read those rows, so a "remind after one day" step silently never resumed and
 * every step after it never ran.
 *
 * A long delay is instead served by chaining hops of at most 900s. Each hop
 * re-enqueues itself carrying the remaining time, so the workflow resumes at
 * roughly the intended moment using only infrastructure that already exists.
 * Slight drift accumulates across hops (each adds queue latency); that is
 * acceptable for reminder-style delays and far better than never firing.
 */

export const SQS_MAX_DELAY_SECONDS = 900;

const UNIT_SECONDS: Record<string, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

export interface DelayConfig {
  duration: number;
  unit: 'minutes' | 'hours' | 'days';
}

/** Total seconds a delay step should wait. Never negative. */
export function delaySecondsFor(config: DelayConfig): number {
  // An unknown unit falls back to minutes rather than 0 — firing immediately
  // would be a silent behaviour change for a step that asked to wait.
  const multiplier = UNIT_SECONDS[config.unit] ?? 60;
  return Math.max(0, Math.floor(config.duration * multiplier));
}

export interface DelayHop {
  /** What to pass to SQS for this hop. */
  delaySeconds: number;
  /** What the next hop must still wait. Zero means this is the last hop. */
  remainingSeconds: number;
}

/** Split a total wait into the next SQS-legal hop plus whatever is left. */
export function planDelayHop(totalSeconds: number): DelayHop {
  if (totalSeconds <= 0) return { delaySeconds: 0, remainingSeconds: 0 };

  const delaySeconds = Math.min(totalSeconds, SQS_MAX_DELAY_SECONDS);
  return { delaySeconds, remainingSeconds: totalSeconds - delaySeconds };
}
