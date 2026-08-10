import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * The upload-url allowlist is the gate a real user hit.
 *
 * They had a zip of documents, the picker would not let them select it, and the
 * agent then told them it could not receive files at all. The archive pipeline
 * is worthless if this enum still rejects the archive, so the accepted types
 * are asserted here rather than left to a hand-check.
 */

vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/database/schema', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/agent-schema/documents', () => ({
  documents: {},
  documentChunks: {},
}))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
}))

async function requestUploadUrl(fileName: string, mimeType: string) {
  const documentsRoutes = (await import('../routes/documents')).default
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', {
      tenant: { id: 'tenant-1' },
      permissions: [{ resource: 'files', action: 'create' }],
    })
    c.set('userId', 'user-1')
    await next()
  })
  app.route('/documents', documentsRoutes)

  return app.request('/documents/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, mimeType }),
  })
}

describe('POST /documents/upload-url accepted types', () => {
  it.each([
    ['corpus.zip', 'application/zip'],
    ['corpus.zip', 'application/x-zip-compressed'],
    ['report.pdf', 'application/pdf'],
    ['notes.txt', 'text/plain'],
    [
      'spec.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ])('issues a presigned URL for %s (%s)', async (fileName, mimeType) => {
    const res = await requestUploadUrl(fileName, mimeType)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ uploadUrl: 'https://signed.example/put' })
  })

  it('rejects a type the ingestion pipeline cannot read', async () => {
    const res = await requestUploadUrl('photo.heic', 'image/heic')

    expect(res.status).toBe(400)
  })
})
