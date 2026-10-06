import { describe, it, expect } from 'vitest';
import { planRateChange } from './credit-rates';

describe('credit rate seed versioning', () => {
  it('inserts version 1 for a rate that does not exist yet', () => {
    expect(planRateChange([], { per_call_micro: 17_000_000 })).toEqual({ action: 'insert', version: 1 });
  });

  it('does nothing when the active row already has this price, in any key order', () => {
    const existing = [{ version: 1, isActive: true, pricingSchema: { per_million_tokens_micro: { output: 60, input: 15 } } }];
    expect(planRateChange(existing, { per_million_tokens_micro: { input: 15, output: 60 } })).toEqual({ action: 'none' });
  });

  it('adds the next version when the price changed, never editing the old row', () => {
    const existing = [
      { version: 1, isActive: false, pricingSchema: { per_call_micro: 50_000 } },
      { version: 2, isActive: true, pricingSchema: { per_call_micro: 170_000 } },
    ];
    expect(planRateChange(existing, { per_call_micro: 17_000_000 })).toEqual({ action: 'insert', version: 3 });
  });

  it('re-activates a price when no row is active', () => {
    const existing = [{ version: 1, isActive: false, pricingSchema: { per_call_micro: 1_000 } }];
    expect(planRateChange(existing, { per_call_micro: 1_000 })).toEqual({ action: 'insert', version: 2 });
  });
});

import { RATES } from './credit-rates';

describe('Lyria 3 jingle rate', () => {
  it('prices lyria-3-clip-preview at its $0.04 per clip (4 credits)', () => {
    expect(RATES.find((r) => r.resourceType === 'music_generation' && r.subject === 'lyria-3-clip-preview')?.pricingSchema).toEqual({ per_call_micro: 4_000_000 });
  });
});
