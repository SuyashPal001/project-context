// Usage-counter registry. Foundation entitlements code asks for the current
// usage of a feature; products register their counters at startup. Keeps
// foundation from importing product schema directly.

type Counter = (tenantId: string) => Promise<number>;

const counters = new Map<string, Counter>();

export function registerUsageCounter(featureKey: string, fn: Counter): void {
    counters.set(featureKey, fn);
}

export async function countUsage(featureKey: string, tenantId: string): Promise<number> {
    const fn = counters.get(featureKey);
    if (!fn) return 0;
    return fn(tenantId);
}
