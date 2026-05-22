type Labels = Record<string, string>;

function labelStr(labels: Labels): string {
  return Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
}

class Counter {
  private counts = new Map<string, number>();

  inc(labels: Labels, by = 1): void {
    const key = labelStr(labels);
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  render(name: string, help: string): string {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
    for (const [labels, val] of this.counts) {
      lines.push(`${name}{${labels}} ${val}`);
    }
    return lines.join('\n');
  }
}

class LatencyTracker {
  private sums  = new Map<string, number>();
  private counts = new Map<string, number>();

  observe(labels: Labels, ms: number): void {
    const key = labelStr(labels);
    this.sums.set(key,   (this.sums.get(key)   ?? 0) + ms);
    this.counts.set(key, (this.counts.get(key)  ?? 0) + 1);
  }

  render(name: string, help: string): string {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
    for (const [labels, sum] of this.sums) {
      const n = this.counts.get(labels) ?? 1;
      lines.push(`${name}_avg_ms{${labels}} ${(sum / n).toFixed(1)}`);
      lines.push(`${name}_count{${labels}} ${n}`);
    }
    return lines.join('\n');
  }
}

export const requestsTotal  = new Counter();
export const fallbacksTotal = new Counter();
export const latency        = new LatencyTracker();

export function circuitStateNum(state: string): number {
  if (state === 'closed')    return 0;
  if (state === 'half-open') return 1;
  return 2; // open
}

export function renderMetrics(
  circuitStates: Record<string, { state: string; failures: number }>,
): string {
  const circuitLines = [
    '# HELP inference_gateway_circuit_state Breaker state: 0=closed 1=half-open 2=open',
    '# TYPE inference_gateway_circuit_state gauge',
    '# HELP inference_gateway_circuit_failures Consecutive failure count per adapter',
    '# TYPE inference_gateway_circuit_failures gauge',
  ];
  for (const [adapter, { state, failures }] of Object.entries(circuitStates)) {
    circuitLines.push(`inference_gateway_circuit_state{adapter="${adapter}"} ${circuitStateNum(state)}`);
    circuitLines.push(`inference_gateway_circuit_failures{adapter="${adapter}"} ${failures}`);
  }

  return [
    requestsTotal.render(
      'inference_gateway_requests_total',
      'Total chat completion requests by adapter and status',
    ),
    fallbacksTotal.render(
      'inference_gateway_fallbacks_total',
      'Fallback events — adapter that failed and adapter that handled the request',
    ),
    latency.render(
      'inference_gateway_request_duration',
      'Request duration per adapter in milliseconds',
    ),
    circuitLines.join('\n'),
  ].join('\n\n') + '\n';
}
