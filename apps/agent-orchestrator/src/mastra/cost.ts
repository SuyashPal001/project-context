import { db, tokenCosts } from '@serverless-saas/database'

// Gemini pricing per 1M tokens (as of mid-2025)
// Self-hosted models (ollama/*) cost $0
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5.00 },
}

export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (model.startsWith('ollama/')) return 0
  const key = model.includes('/') ? model.split('/').pop()! : model
  const p = PRICING[key] ?? PRICING['gemini-2.5-flash']
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export interface CostRecord {
  tenantId: string
  agentId?: string
  workflowId?: string
  runId?: string
  model: string
  inputTokens: number
  outputTokens: number
}

export function persistCost(record: CostRecord): void {
  const costUsd = calculateCostUsd(record.model, record.inputTokens, record.outputTokens)
  db.insert(tokenCosts).values({
    tenantId: record.tenantId,
    agentId: record.agentId,
    workflowId: record.workflowId,
    runId: record.runId,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: String(costUsd),
  }).catch(err => {
    console.error('[cost] persistCost failed', err)
  })
}
