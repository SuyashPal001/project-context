import { Hono } from 'hono'
import { db, pensionCases } from '@serverless-saas/database'
import { eq } from 'drizzle-orm'
import { mastra } from '../mastra/index.js'

export const pensionRoutes = new Hono()

pensionRoutes.post('/internal/pension/run', async (c) => {
  let body: { caseId?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }

  const { caseId } = body
  if (!caseId) return c.json({ error: 'caseId required' }, 400)

  const [kase] = await db.select().from(pensionCases).where(eq(pensionCases.id, caseId))
  if (!kase) return c.json({ error: 'case not found' }, 404)

  const fields = kase.fields as Record<string, unknown>
  const numericFields: Record<string, number> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') numericFields[k] = v
  }

  const presentDocs = (fields.present_docs as string[] | undefined) ?? []
  const fieldSources = (fields.field_sources as Record<string, { sourceDoc: string; sourcePage: number }> | undefined) ?? {}

  try {
    // CONFIRMED LIVE: createRun() is synchronous, run.start() is async
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (mastra.getWorkflow('pension-pre-scrutiny') as any).createRun()
    const result = await run.start({
      inputData: {
        caseId: kase.id,
        tenantId: kase.tenantId,
        caseRef: kase.caseRef,
        pensionerName: kase.pensionerName,
        presentDocs,
        fields: numericFields,
        fieldSources,
      },
    })
    return c.json({ caseId, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[pension/run] workflow error', message)
    return c.json({ error: message }, 500)
  }
})
