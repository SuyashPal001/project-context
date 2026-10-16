import { Hono } from 'hono'
import { z } from 'zod'
import { isInternalServiceKey } from '../service-key.js'
import { brandImportWorkflow, reportImportResult } from '../mastra/workflows/brandImportWorkflow.js'

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  source: z.enum(['website', 'instagram']),
  handle: z.string().regex(/^[a-z0-9._]{1,30}$/).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
}).refine((b) => (b.source === 'instagram' ? !!b.handle : !!b.facts), { message: 'handle or facts required' })

export const brandImportRouter = new Hono()

brandImportRouter.post('/internal/brand/import', async (c) => {
  if (!isInternalServiceKey(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const inputData = parsed.data
  const run = await brandImportWorkflow.createRun()
  // Ack now; the API polls the row. Any failure is reported so the page stops waiting.
  void Promise.resolve(run.start({ inputData }))
    .then((result: any) => {
      if (result?.status !== 'success') {
        console.error('[brandImport] run did not succeed', { tenantId: inputData.tenantId, runId: run.runId, status: result?.status, error: result?.error?.message })
        return reportImportResult({ tenantId: inputData.tenantId, ok: false, error: String(result?.error?.message ?? result?.status ?? 'failed').slice(0, 500) })
      }
    })
    .catch((err: Error) => {
      console.error('[brandImport] run threw', { tenantId: inputData.tenantId, error: err.message })
      return reportImportResult({ tenantId: inputData.tenantId, ok: false, error: err.message.slice(0, 500) }).catch(() => {})
    })
  return c.json({ runId: run.runId }, 202)
})
