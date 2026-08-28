import { describe, it, expect } from 'vitest';
import { costMicro, MICRO_PER_CREDIT } from '../rate';

describe('costMicro', () => {
  const flash = { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } };

  it('prices tokens per million and rounds up once, after summing', () => {
    // 2000 * 15 + 500 * 60 = 30_000 + 30_000 = 60_000 micro exactly
    expect(costMicro(flash, { inputTokens: 2000, outputTokens: 500 })).toBe(60_000n);
  });

  it('rounds a fractional total up, never down', () => {
    expect(costMicro(flash, { inputTokens: 1, outputTokens: 0 })).toBe(15n);
    expect(costMicro({ per_million_tokens_micro: { input: 1, output: 0 } },
                     { inputTokens: 1, outputTokens: 0 })).toBe(1n);   // 0.000001 -> 1
  });

  it('prices flat resources by count', () => {
    expect(costMicro({ per_message_micro: 250_000 }, { count: 2 })).toBe(500_000n);
    expect(costMicro({ per_call_micro: 0 }, { count: 7 })).toBe(0n);
    expect(costMicro({ per_run_micro: 1_000_000 }, { count: 1 })).toBe(MICRO_PER_CREDIT);
  });

  it('treats missing usage as zero rather than NaN', () => {
    expect(costMicro(flash, {})).toBe(0n);
  });
});
