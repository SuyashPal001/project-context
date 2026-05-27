import { NextResponse } from 'next/server';

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001';

interface AdapterLatency { adapter: string; ttft_avg_ms: number; ttft_count: number }

function parse(text: string): AdapterLatency[] {
  const avgs = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('metric="ttft"')) continue;
    const adapter = line.match(/adapter="([^"]+)"/)?.[1];
    const value = parseFloat(line.match(/\}\s+([\d.]+)/)?.[1] ?? 'NaN');
    if (!adapter || isNaN(value)) continue;
    if (line.includes('_avg_ms{')) avgs.set(adapter, value);
    else if (line.includes('_count{')) counts.set(adapter, value);
  }
  return Array.from(avgs.entries()).map(([adapter, ttft_avg_ms]) => ({
    adapter, ttft_avg_ms, ttft_count: counts.get(adapter) ?? 0,
  }));
}

export async function GET() {
  try {
    const res = await fetch(`${GATEWAY_URL}/metrics`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ adapters: [] });
    return NextResponse.json({ adapters: parse(await res.text()) });
  } catch {
    return NextResponse.json({ adapters: [] });
  }
}
