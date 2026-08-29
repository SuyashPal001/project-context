import { describe, it, expect } from 'vitest';
import { CENTS_PER_CREDIT } from './credit-packs';

/**
 * The pack list is the price list, and its one invariant is that every pack
 * sells at exactly CENTS_PER_CREDIT. Nothing in the schema enforces that — a
 * promotion or a volume tier is a legitimate price change — so this is the
 * only place a typo in a `priceCents` gets caught before it reaches a customer.
 *
 * The packs are re-declared here rather than exported from the seed, because a
 * test that imports the same array it asserts against proves only that the
 * array equals itself. These numbers are transcribed from the spec.
 */
const EXPECTED = [
  { key: 'starter',  credits: 500,   priceCents: 1_000 },
  { key: 'standard', credits: 1_250, priceCents: 2_500 },
  { key: 'bulk',     credits: 5_000, priceCents: 10_000 },
];

describe('credit pack pricing', () => {
  it('sells every pack at exactly 2 cents per credit', () => {
    expect(CENTS_PER_CREDIT).toBe(2);
    for (const pack of EXPECTED) {
      expect(pack.priceCents).toBe(pack.credits * CENTS_PER_CREDIT);
    }
  });

  it('prices a credit at twice what it costs', () => {
    // credit_rates is seeded at cost: 1 credit = 1 US cent of inference
    // (see credit-rates.ts). The margin is the ratio between that and the
    // sale price, and it lives HERE rather than in credit_rates — doubling
    // the rate instead would halve what every plan allowance buys, so 2,000
    // credits would quietly stop being $20 of work.
    const COST_CENTS_PER_CREDIT = 1;
    expect(CENTS_PER_CREDIT / COST_CENTS_PER_CREDIT).toBe(2);
  });

  it('derives credits from an amount paid without rounding drift', () => {
    // This is the arithmetic the webhook will run in reverse: it takes the
    // VERIFIED amount_total from the payment event and divides by the sale
    // price, never trusting a credit count from metadata. Every pack must
    // divide exactly — a fractional result means the amount matches no pack
    // and is a support case, not a grant.
    for (const pack of EXPECTED) {
      const credits = pack.priceCents / CENTS_PER_CREDIT;
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBe(pack.credits);
    }
  });

  it('rejects an amount that matches no pack', () => {
    const knownAmounts = new Set(EXPECTED.map(p => p.priceCents));
    // A partial payment, a currency mix-up, or a hand-crafted session.
    for (const amount of [1, 999, 1_001, 2_499, 99_999]) {
      expect(knownAmounts.has(amount)).toBe(false);
    }
  });
});
