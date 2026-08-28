// Pure date arithmetic for the credits backfill (backfillCredits.ts). Split out
// so it can carry its own unit test without a database.

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
