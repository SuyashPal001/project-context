import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const LAKEHOUSE_URL = process.env.LAKEHOUSE_URL ?? 'http://localhost:8001';

export async function lakehouseCommit(fields: Array<{ key: string; label: string; value: string; confidence: number }>, filename: string, fileId: string, tenantId?: string): Promise<{ version: number; label: string }> {
  const getValue = (key: string) => fields.find(f => f.key === key)?.value ?? ''
  const rawAmount = getValue('pension_amount').replace(/[^0-9.]/g, '')
  const body = {
    records: [{
      pension_id: getValue('ppo_number') || `PEN-${fileId.slice(0, 8)}`,
      pensioner_name: getValue('pensioner_name') || 'Unknown',
      declared_amount: parseFloat(rawAmount) || 0,
      status: 'original',
      office_code: tenantId ?? 'unknown',
      effective_date: getValue('effective_date') || new Date().toISOString().split('T')[0],
    }],
    label: `Ingestion — ${filename}`,
    description: 'Committed via Mastra ingestion workflow',
  }
  try {
    const res = await fetch(`${LAKEHOUSE_URL}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { version: -1, label: 'Failed' }
    return await res.json() as { version: number; label: string }
  } catch {
    return { version: -1, label: 'Lakehouse unavailable' }
  }
}

export const lakehouseCommitTool = createTool({
  id: 'lakehouse-commit',
  description: 'Commits a single extracted record to the Delta Lake lakehouse, creating a new snapshot.',
  inputSchema: z.object({
    fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string(), confidence: z.number() })),
    filename: z.string(),
    fileId: z.string(),
  }),
  outputSchema: z.object({
    version: z.number(),
    label: z.string(),
  }),
  execute: async (inputData) => {
    return lakehouseCommit(inputData.fields, inputData.filename, inputData.fileId)
  },
});
