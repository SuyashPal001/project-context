import { describe, it, expect } from 'vitest';
import { planDelayHop, delaySecondsFor, SQS_MAX_DELAY_SECONDS } from './delay-chain';

/**
 * F-14 — notification delays longer than 15 minutes must actually fire.
 *
 * The bug: SQS caps DelaySeconds at 900, so delays above that took an `else`
 * branch that wrote a notificationJobs row with status 'pending' and logged
 * "EventBridge pickup not yet implemented". Nothing ever read those rows. Any
 * step with a delay over 15 minutes — a "remind after one day" step being the
 * obvious case — silently never resumed, and every step after it never ran.
 *
 * Rather than depend on infrastructure that does not exist, a long delay is now
 * served by chaining hops of at most 900s, carrying the remainder forward.
 */

describe('delaySecondsFor', () => {
  it('converts each supported unit to seconds', () => {
    expect(delaySecondsFor({ duration: 5, unit: 'minutes' })).toBe(300);
    expect(delaySecondsFor({ duration: 2, unit: 'hours' })).toBe(7200);
    expect(delaySecondsFor({ duration: 1, unit: 'days' })).toBe(86400);
  });

  it('falls back to minutes for an unrecognised unit rather than firing instantly', () => {
    expect(delaySecondsFor({ duration: 3, unit: 'fortnights' as never })).toBe(180);
  });

  it('treats a negative or zero duration as no delay', () => {
    expect(delaySecondsFor({ duration: 0, unit: 'hours' })).toBe(0);
    expect(delaySecondsFor({ duration: -5, unit: 'hours' })).toBe(0);
  });
});

describe('planDelayHop', () => {
  it('schedules a short delay in a single hop', () => {
    expect(planDelayHop(300)).toEqual({ delaySeconds: 300, remainingSeconds: 0 });
  });

  it('schedules exactly the SQS maximum in a single hop', () => {
    expect(planDelayHop(SQS_MAX_DELAY_SECONDS)).toEqual({
      delaySeconds: SQS_MAX_DELAY_SECONDS,
      remainingSeconds: 0,
    });
  });

  it('splits a delay longer than the maximum and carries the remainder', () => {
    // One hour: the case that previously vanished.
    expect(planDelayHop(3600)).toEqual({
      delaySeconds: SQS_MAX_DELAY_SECONDS,
      remainingSeconds: 3600 - SQS_MAX_DELAY_SECONDS,
    });
  });

  it('never asks SQS for more than it accepts', () => {
    for (const total of [901, 3600, 86400, 604800]) {
      expect(planDelayHop(total).delaySeconds).toBeLessThanOrEqual(SQS_MAX_DELAY_SECONDS);
    }
  });

  it('chains to exactly the requested total for a one-day delay', () => {
    let remaining = 86400;
    let elapsed = 0;
    let hops = 0;
    while (remaining > 0) {
      const hop = planDelayHop(remaining);
      elapsed += hop.delaySeconds;
      remaining = hop.remainingSeconds;
      hops++;
      expect(hops).toBeLessThan(200); // guards against a non-terminating chain
    }
    expect(elapsed).toBe(86400);
  });

  it('terminates for any delay rather than looping forever', () => {
    let remaining = 604800; // one week
    let hops = 0;
    while (remaining > 0 && hops < 5000) {
      remaining = planDelayHop(remaining).remainingSeconds;
      hops++;
    }
    expect(remaining).toBe(0);
  });

  it('treats a non-positive delay as fire-now', () => {
    expect(planDelayHop(0)).toEqual({ delaySeconds: 0, remainingSeconds: 0 });
    expect(planDelayHop(-10)).toEqual({ delaySeconds: 0, remainingSeconds: 0 });
  });
});
