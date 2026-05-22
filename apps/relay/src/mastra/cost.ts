// Gemini pricing per 1M tokens (as of mid-2025)
// Self-hosted models (ollama/*) cost $0
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5.00 },
}

export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (model.startsWith('ollama/')) return 0
  // Strip provider prefix if present (e.g. "google/gemini-2.5-flash" → "gemini-2.5-flash")
  const key = model.includes('/') ? model.split('/').pop()! : model
  const p = PRICING[key] ?? PRICING['gemini-2.5-flash']
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}
