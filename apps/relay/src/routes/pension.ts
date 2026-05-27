import { Hono } from 'hono'
import { db, pensionCases } from '@serverless-saas/database'
import { eq } from 'drizzle-orm'
import { mastra } from '../mastra/index.js'

// ---------------------------------------------------------------------------
// In-memory map: caseId → Mastra runId.
// Populated on /run when the workflow suspends at the officer-review gate.
// Used by /resume so the Lambda API only needs to pass caseId.
// Lives in relay process memory — safe for demo; a prod system would persist.
// ---------------------------------------------------------------------------
const pendingRunIds = new Map<string, string>()

const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? ''

function checkInternalKey(c: any): boolean {
  const key = c.req.header('x-internal-service-key') ?? ''
  return !INTERNAL_KEY || key === INTERNAL_KEY
}

export const pensionRoutes = new Hono()

// POST /internal/pension/run
// Loads a pension case and runs the pre-scrutiny workflow.
// If the workflow suspends (officer-review gate), stores runId and returns
// { status: 'suspended', runId, caseId } so the caller knows to await resume.
pensionRoutes.post('/internal/pension/run', async (c) => {
  if (!checkInternalKey(c)) return c.json({ error: 'Unauthorized' }, 401)

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = await (mastra.getWorkflow('pension-pre-scrutiny') as any).createRun()
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)?.status === 'suspended') {
      const runId: string = run.id ?? run.runId ?? ''
      if (runId && caseId) pendingRunIds.set(caseId, runId)
      console.log(`[pension/run] workflow suspended for caseId=${caseId} runId=${runId}`)
      return c.json({ status: 'suspended', runId, caseId })
    }

    return c.json({ status: 'completed', caseId, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[pension/run] workflow error', message)
    return c.json({ error: message }, 500)
  }
})

// POST /internal/pension/resume
// Resumes a suspended pension workflow run at the officer-review gate.
// Body: { caseId, action, rationale?, officerId?, actorRole? }
// Called by the Lambda API pension action endpoint after writing the audit log.
pensionRoutes.post('/internal/pension/resume', async (c) => {
  if (!checkInternalKey(c)) return c.json({ error: 'Unauthorized' }, 401)

  let body: {
    caseId?: string
    runId?: string
    action?: 'accept' | 'override' | 'escalate'
    rationale?: string
    officerId?: string
    actorRole?: string
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }

  const { caseId, action, rationale, officerId, actorRole } = body
  if (!caseId || !action) return c.json({ error: 'caseId and action required' }, 400)

  // Resolve runId — prefer explicit, fall back to in-memory map
  const runId = body.runId ?? pendingRunIds.get(caseId)
  if (!runId) return c.json({ error: `No pending run found for caseId=${caseId}` }, 404)

  try {
    const wf = mastra.getWorkflow('pension-pre-scrutiny')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (wf as any).createRun({ runId })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (run as any).resume({
      resumeData: { action, rationale, officerId, actorRole },
      step: 'pension-route-to-officer',
    })

    pendingRunIds.delete(caseId) // clean up after resume
    console.log(`[pension/resume] resumed runId=${runId} action=${action} status=${result?.status}`)
    return c.json({ status: result?.status ?? 'unknown', caseId, runId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[pension/resume] error', message)
    return c.json({ error: message }, 500)
  }
})
