import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[savePRD] pool error:', err.message)
    })
  }
  return _pool
}

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const savePRD = createTool({
  id: 'save-prd',
  description: 'Saves or updates a PRD draft in agent_prds. Pass existingPrdId to update an existing draft.',
  requestContextSchema,
  inputSchema: z.object({
    title: z.string(),
    content: z.string(),
    contentType: z.enum(['markdown', 'html']),
    existingPrdId: z.string().optional(),
  }),
  outputSchema: z.object({
    prdId: z.string(),
    version: z.number(),
    status: z.string(),
    content: z.string(),
  }),
  execute: async (inputData, execContext) => {
    const { title, content, contentType, existingPrdId } = inputData as any
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId  = execContext?.requestContext?.get('agentId')  as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      if (existingPrdId) {
        const { rows } = await client.query<{ id: string; version: number; status: string }>(
          `UPDATE agent_prds
           SET title = $1, content = $2, content_type = $3,
               version = version + 1, updated_at = now()
           WHERE id = $4 AND tenant_id = $5
           RETURNING id, version, status`,
          [title, content, contentType, existingPrdId, tenantId],
        )
        if (rows.length === 0) {
          throw new Error(`PRD ${existingPrdId} not found for tenant ${tenantId}`)
        }
        return { prdId: rows[0].id, version: rows[0].version, status: rows[0].status, content }
      }

      const { rows } = await client.query<{ id: string; version: number; status: string }>(
        `INSERT INTO agent_prds (agent_id, tenant_id, title, content, content_type, status, version)
         VALUES ($1, $2, $3, $4, $5, 'draft', 1)
         RETURNING id, version, status`,
        [agentId, tenantId, title, content, contentType],
      )
      return { prdId: rows[0].id, version: rows[0].version, status: rows[0].status, content }
    } finally {
      client.release()
    }
  },
})
