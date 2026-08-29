import { describe, it, expect } from 'vitest';
import { addUtcMonthsClamped, nextCycleEnd } from './cycleEnd';

describe('addUtcMonthsClamped', () => {
  it('adds a plain month with no day-of-month issue', () => {
    const d = addUtcMonthsClamped(new Date('2026-03-10T12:00:00.000Z'), 1);
    expect(d.toISOString()).toBe('2026-04-10T12:00:00.000Z');
  });

  it('clamps Jan 31 + 1 month to Feb 28 in a non-leap year', () => {
    const d = addUtcMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 1);
    expect(d.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    const d = addUtcMonthsClamped(new Date('2028-01-31T00:00:00.000Z'), 1);
    expect(d.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('does not roll a clamped month over into the next one (no Mar 3 drift)', () => {
    const d = addUtcMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 1);
    expect(d.getUTCMonth()).toBe(1); // February, not March
  });

  it('crosses a year boundary', () => {
    const d = addUtcMonthsClamped(new Date('2026-12-15T00:00:00.000Z'), 1);
    expect(d.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('adds 12 months (annual step) across a leap-day anniversary', () => {
    const d = addUtcMonthsClamped(new Date('2028-02-29T00:00:00.000Z'), 12);
    expect(d.toISOString()).toBe('2029-02-28T00:00:00.000Z'); // 2029 is not a leap year
  });
});

describe('nextCycleEnd', () => {
  it('monthly: returns next month\'s anniversary when now is mid-cycle', () => {
    const started = new Date('2026-01-15T00:00:00.000Z');
    const now = new Date('2026-08-20T00:00:00.000Z');
    const end = nextCycleEnd(started, 'monthly', now);
    expect(end.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('monthly: steps past a cycle boundary exactly at the anniversary instant', () => {
    const started = new Date('2026-01-15T00:00:00.000Z');
    const now = new Date('2026-08-15T00:00:00.000Z'); // exactly on an anniversary
    const end = nextCycleEnd(started, 'monthly', now);
    // "strictly after now" - the anniversary instant itself has already elapsed
    expect(end.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('annual: returns the next yearly anniversary', () => {
    const started = new Date('2024-03-01T00:00:00.000Z');
    const now = new Date('2026-08-28T00:00:00.000Z');
    const end = nextCycleEnd(started, 'annual', now);
    expect(end.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('monthly: a Jan-31 start cycles on clamped month-ends, not calendar drift', () => {
    const started = new Date('2026-01-31T00:00:00.000Z');
    const now = new Date('2026-02-28T12:00:00.000Z'); // just after the Feb cycle end
    const end = nextCycleEnd(started, 'monthly', now);
    expect(end.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});
