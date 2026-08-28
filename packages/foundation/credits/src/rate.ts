export const MICRO_PER_CREDIT = 1_000_000n;

export type PricingSchema =
  | { per_million_tokens_micro: { input: number; output: number } }
  | { per_message_micro: number }
  | { per_call_micro: number }
  | { per_run_micro: number };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  count?: number;
}

/** Cost in micro-credits. Rounds UP exactly once, after summing components. */
export function costMicro(schema: PricingSchema, usage: Usage): bigint {
  if ('per_million_tokens_micro' in schema) {
    const { input, output } = schema.per_million_tokens_micro;
    const numerator =
      BigInt(usage.inputTokens ?? 0) * BigInt(input) +
      BigInt(usage.outputTokens ?? 0) * BigInt(output);
    return ceilDiv(numerator, 1_000_000n);
  }
  const flat =
    'per_message_micro' in schema ? schema.per_message_micro
    : 'per_call_micro' in schema ? schema.per_call_micro
    : schema.per_run_micro;
  return BigInt(flat) * BigInt(usage.count ?? 0);
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return n <= 0n ? 0n : (n + d - 1n) / d;
}
