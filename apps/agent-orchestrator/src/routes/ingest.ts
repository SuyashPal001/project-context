import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, files } from '@serverless-saas/database'
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
  tenantName?: string
  classification?: string
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
      fileId:             b.fileId as string,
      filename:           b.filename as string,
      mimeType:           b.mimeType as string,
      bufferBase64:       b.bufferBase64 as string,
      extractedText:      b.extractedText as string | undefined,
      tenantId:           b.tenantId as string,
      personalIdentifier: b.personalIdentifier as string | undefined,
      personFolderId:     b.personFolderId as string | undefined,
      tenantName:         b.tenantName as string | undefined,
      classification:     b.classification as string | undefined,
    },
  }
}

async function runWorkflow(body: IngestBody): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = await (ingestionWorkflow as any).createRun()
    const result = await run.start({ inputData: body })

    if (result.status === 'success') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (result as any).result
      await db
        .update(files)
        .set({
          formatDetected:  out.formatDetected ?? null,
          chunkCount:      out.chunkCount ?? 0,
          extractedFields: (out.extractedFields ?? null) as any,
          ingestionStatus: 'done',
          officeCode:      (body.tenantName ?? '').slice(0, 32) || null,
          classification:  body.classification ?? 'Internal',
          updatedAt:       new Date(),
        })
        .where(and(eq(files.id, body.fileId), eq(files.tenantId, body.tenantId)))
      console.log(`[ingest] done fileId=${body.fileId} chunks=${out.chunkCount}`)
    } else {
      await db
        .update(files)
        .set({ ingestionStatus: 'failed', updatedAt: new Date() })
        .where(and(eq(files.id, body.fileId), eq(files.tenantId, body.tenantId)))
      console.error(`[ingest] workflow status=${result.status} fileId=${body.fileId}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ingest] workflow error fileId=${body.fileId}`, msg)
    await db
      .update(files)
      .set({ ingestionStatus: 'failed', updatedAt: new Date() })
      .where(and(eq(files.id, body.fileId), eq(files.tenantId, body.tenantId)))
      .catch(() => {})
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

  // Fire workflow in background — return immediately so Lambda/API Gateway don't time out
  void runWorkflow(parsed.body)

  return c.json({ ok: true, async: true })
})
