import { Hono } from 'hono'
import { ingestionWorkflow } from '../mastra/workflows/ingestionWorkflow.js'

interface IngestBody {
  fileId: string
  filename: string
  mimeType: string
  bufferBase64: string
  extractedText?: string
  tenantId: string
  personalIdentifier?: string
  personFolderId?: string
}

function validateBody(raw: unknown): { ok: true; body: IngestBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const b = raw as Record<string, unknown>
  const required = ['fileId', 'filename', 'mimeType', 'bufferBase64', 'tenantId'] as const
  for (const key of required) {
    if (typeof b[key] !== 'string' || !(b[key] as string).length) {
      return { ok: false, error: `missing or invalid field: ${key}` }
    }
  }
  if (b.extractedText !== undefined && typeof b.extractedText !== 'string') {
    return { ok: false, error: 'extractedText must be a string when present' }
  }
  if (b.personalIdentifier !== undefined && typeof b.personalIdentifier !== 'string') {
    return { ok: false, error: 'personalIdentifier must be a string when present' }
  }
  if (b.personFolderId !== undefined && typeof b.personFolderId !== 'string') {
    return { ok: false, error: 'personFolderId must be a string when present' }
  }
  return {
    ok: true,
    body: {
      fileId: b.fileId as string,
      filename: b.filename as string,
      mimeType: b.mimeType as string,
      bufferBase64: b.bufferBase64 as string,
      extractedText: b.extractedText as string | undefined,
      tenantId: b.tenantId as string,
      personalIdentifier: b.personalIdentifier as string | undefined,
      personFolderId: b.personFolderId as string | undefined,
    },
  }
}

export const ingestRoute = new Hono()

ingestRoute.post('/internal/ingest', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400)
  }

  const parsed = validateBody(raw)
  if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = await (ingestionWorkflow as any).createRun()
    const result = await run.start({ inputData: parsed.body })

    if (result.status === 'success') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (result as any).result
      return c.json({
        ok: true,
        formatDetected: out.formatDetected,
        documentType: out.documentType,
        classificationConfidence: out.classificationConfidence,
        extractedFields: out.extractedFields,
        chunkCount: out.chunkCount,
        lakehouseVersion: out.lakehouseVersion,
        overallQuality: out.overallQuality,
        needsReview: out.needsReview,
        validationIssues: out.validationIssues,
        runId: run.runId,
      })
    }

    return c.json({ ok: false, status: result.status, error: 'Workflow did not complete' }, 500)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[ingest] workflow error', message)
    return c.json({ ok: false, error: message }, 500)
  }
})
