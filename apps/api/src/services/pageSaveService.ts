import { createHash, randomUUID } from 'crypto'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { stripHtml } from '../utils/stripHtml.js'
import { publishToQueue } from '../lib/sqs.js'
import { getPool, rowToPage, type SavePageData, type Page } from './pageService.js'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

function pageDocHash(pageId: string): string {
  return createHash('sha256').update(`wiki_page:${pageId}`).digest('hex')
}

// ─── savePage ─────────────────────────────────────────────────────────────────
// Transactional: updates page row, writes version snapshot, trims old versions,
// uploads stripped text to S3, upserts document record, fires SQS ingest event.

export async function savePage(
  tenantId: string,
  userId: string,
  pageId: string,
  data: SavePageData,
): Promise<Page> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const html = data.descriptionHtml ?? '<p></p>'
    const stripped = stripHtml(html)
    const json = data.descriptionJson ?? {}

    // 1. UPDATE project_pages
    const { rows: pageRows } = await client.query<Record<string, unknown>>(
      `UPDATE project_pages SET
         title              = COALESCE($3, title),
         description_html   = $4,
         description_json   = $5::jsonb,
         description_stripped = $6,
         updated_at         = NOW()
       WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL
       RETURNING *`,
      [tenantId, pageId, data.title ?? null, html, JSON.stringify(json), stripped],
    )
    if (!pageRows.length) throw new Error('Page not found or archived')
    const pageRow = pageRows[0]

    // 2. INSERT version snapshot
    await client.query(
      `INSERT INTO project_page_versions
         (id, tenant_id, page_id, owned_by,
          description_html, description_json, description_stripped, last_saved_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
      [randomUUID(), tenantId, pageId, userId, html, JSON.stringify(json), stripped],
    )

    // 3. DELETE versions with rank > 20 (window function, single query)
    await client.query(
      `DELETE FROM project_page_versions
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY last_saved_at DESC) AS rn
           FROM project_page_versions WHERE page_id = $1
         ) ranked WHERE rn > 20
       )`,
      [pageId],
    )

    // 4. Upload stripped text to S3 so worker can ingest it (text/plain pipeline)
    const s3FileKey = `tenants/${tenantId}/pages/${pageId}.txt`
    await s3.send(new PutObjectCommand({
      Bucket: process.env.DOCUMENTS_BUCKET!,
      Key: s3FileKey,
      Body: stripped,
      ContentType: 'text/plain',
    }))

    // 5. Upsert documents record for RAG — includes file_key + mime_type for worker
    const hash = pageDocHash(pageId)
    const planId = pageRow.plan_id as string | null
    const { rows: docRows } = await client.query<{ id: string }>(
      `INSERT INTO documents
         (id, tenant_id, uploaded_by, name, status, hash, file_key, mime_type, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, 'text/plain', $7::jsonb)
       ON CONFLICT (tenant_id, hash) DO UPDATE SET
         name       = EXCLUDED.name,
         status     = 'pending',
         file_key   = EXCLUDED.file_key,
         metadata   = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        randomUUID(), tenantId, userId,
        (pageRow.title as string) ?? 'Untitled',
        hash, s3FileKey,
        JSON.stringify({ sourceType: 'wiki_page', pageId, planId, tenantId }),
      ],
    )

    // 6. UPDATE project_pages.document_id
    const docId = docRows[0].id
    await client.query(
      `UPDATE project_pages SET document_id = $1 WHERE id = $2`,
      [docId, pageId],
    )
    pageRow.document_id = docId

    await client.query('COMMIT')

    // 7. Fire SQS after commit — fire-and-forget, never fails the save
    const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL
    if (queueUrl) {
      publishToQueue(queueUrl, {
        type: 'document.ingest',
        payload: { tenantId, documentId: docId, fileKey: s3FileKey, mimeType: 'text/plain' },
      }).catch((err: Error) => console.error('[pageSaveService] SQS fire failed:', err.message))
    }

    return rowToPage(pageRow)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ─── restoreVersion ───────────────────────────────────────────────────────────

export async function restoreVersion(
  tenantId: string,
  userId: string,
  pageId: string,
  versionId: string,
): Promise<Page> {
  const { rows: vRows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM project_page_versions
     WHERE tenant_id = $1 AND id = $2 AND page_id = $3`,
    [tenantId, versionId, pageId],
  )
  if (!vRows.length) throw new Error('Version not found')
  const v = vRows[0]
  return savePage(tenantId, userId, pageId, {
    descriptionHtml: v.description_html as string,
    descriptionJson: (v.description_json ?? {}) as Record<string, unknown>,
  })
}
