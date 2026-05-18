import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[fetchPRD] pool error:', err.message)
    })
  }
  return _pool
}

const prdRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  contentType: z.string(),
  status: z.string(),
})

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const fetchPRD = createTool({
  id: 'fetch-prd',
  description: 'Reads an agent_prds record by id. By default requires approved status; set allowDraft=true to read drafts too. Returns null with a reason if not found.',
  requestContextSchema,
  inputSchema: z.object({
    prdId: z.string(),
    allowDraft: z.boolean().optional().describe('Set true to read draft PRDs (for editing). Defaults to false (approved only).'),
  }),
  outputSchema: z.object({
    prd: prdRowSchema.nullable(),
    reason: z.string().nullable(),
  }),
  execute: async (inputData, execContext) => {
    const prdId = inputData?.prdId ?? ''
    const allowDraft = (inputData as any)?.allowDraft ?? false
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      const { rows } = await client.query<{
        id: string
        title: string
        content: string
        content_type: string
        status: string
      }>(
        `SELECT id, title, content, content_type, status
         FROM agent_prds
         WHERE id = $1 AND tenant_id = $2`,
        [prdId, tenantId],
      )

      if (rows.length === 0) {
        return { prd: null, reason: `PRD ${prdId} not found for tenant ${tenantId}` }
      }

      const row = rows[0]

      if (row.status !== 'approved' && !allowDraft) {
        return {
          prd: null,
          reason: `PRD "${row.title}" has status "${row.status}" — it must be approved before generating a roadmap`,
        }
      }

      return {
        prd: {
          id: row.id,
          title: row.title,
          content: row.content,
          contentType: row.content_type,
          status: row.status,
        },
        reason: null,
      }
    } finally {
      client.release()
    }
  },
})
