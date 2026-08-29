// Pure date arithmetic for billing-cycle ends. Lives at the package root (not
// under scripts/) so it compiles into dist/ and is importable as
// `@serverless-saas/database` from other packages - scripts/ is excluded from
// this package's tsc build (see tsconfig.json) because most of scripts/ has
// import-time side effects (opens its own postgres connection) that must
// never run as a side effect of importing @serverless-saas/database.
//
// scripts/cycleEnd.ts re-exports this file for backward compatibility with
// the credits backfill script (task 7), which imports it by relative path
// with tsx (bypassing tsc entirely, so the exclude above doesn't apply to it).

export type BillingCycle = 'monthly' | 'annual';

function daysInUtcMonth(year: number, monthIndex0: number): number {
  // Day 0 of the month *after* the target is that target month's last day.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Adds `months` calendar months to `date` (UTC), clamping the day-of-month to
 * the target month's last valid day instead of rolling over. Native `Date`
 * arithmetic on an out-of-range day rolls forward (Jan 31 + 1 month becomes
 * Mar 3, skipping February); this clamps it to Feb 28 (or 29 in a leap year)
 * instead, which is the usual billing-cycle convention - the anniversary
 * "sticks" to month-end rather than drifting across months.
 */
export function addUtcMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const totalMonths = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(
    targetYear, targetMonth, clampedDay,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));
}

/**
 * The tenant's current billing-cycle end: the next anniversary of `startedAt`
 * strictly after `now`, stepping by 1 month (`monthly`) or 12 months
 * (`annual`). Day-of-month is clamped per addUtcMonthsClamped - a
 * subscription started Jan 31 cycles on Feb 28/29, Mar 31, Apr 30, ...
 */
export function nextCycleEnd(startedAt: Date, billingCycle: BillingCycle, now: Date = new Date()): Date {
  const step = billingCycle === 'annual' ? 12 : 1;
  let n = 1;
  let end = addUtcMonthsClamped(startedAt, step * n);
  while (end.getTime() <= now.getTime()) {
    n += 1;
    end = addUtcMonthsClamped(startedAt, step * n);
  }
  return end;
}
