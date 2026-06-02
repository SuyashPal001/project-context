import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[fetchPlan] pool error:', err.message)
    })
  }
  return _pool
}

const milestoneSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.string(),
  status: z.string(),
  acceptance_criteria: z.array(z.any()),
})

const planRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  targetDate: z.string().nullable(),
  milestones: z.array(milestoneSchema),
})

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const fetchPlan = createTool({
  id: 'fetch-plan',
  description: 'Reads a project_plans record with its milestones by planId. Returns null with a reason if not found.',
  requestContextSchema,
  inputSchema: z.object({
    planId: z.string(),
  }),
  outputSchema: z.object({
    plan: planRowSchema.nullable(),
    reason: z.string().nullable(),
  }),
  execute: async (inputData, execContext) => {
    const planId = inputData?.planId ?? ''
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      const { rows } = await client.query<{
        id: string
        title: string
        description: string | null
        status: string
        target_date: string | null
        milestones: Array<{
          id: string
          title: string
          description: string | null
          priority: string
          status: string
          acceptance_criteria: unknown[]
        }> | null
      }>(
        `SELECT p.id, p.title, p.description, p.status, p.target_date,
                json_agg(json_build_object(
                  'id', m.id,
                  'title', m.title,
                  'description', m.description,
                  'priority', m.priority,
                  'acceptance_criteria', m.acceptance_criteria,
                  'status', m.status
                ) ORDER BY m.created_at) AS milestones
         FROM project_plans p
         LEFT JOIN project_milestones m ON m.plan_id = p.id AND m.deleted_at IS NULL
         WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NULL
         GROUP BY p.id`,
        [planId, tenantId],
      )

      if (rows.length === 0) {
        return { plan: null, reason: `Plan ${planId} not found for tenant ${tenantId}` }
      }

      const row = rows[0]

      if (row.status !== 'active') {
        return {
          plan: null,
          reason: `Plan "${row.title}" has status "${row.status}" — it must be active before generating tasks`,
        }
      }

      // json_agg returns [null] when there are no milestones (LEFT JOIN with no matches)
      const milestones = (row.milestones ?? []).filter((m) => m.id !== null)

      return {
        plan: {
          id: row.id,
          title: row.title,
          description: row.description ?? null,
          status: row.status,
          targetDate: row.target_date ?? null,
          milestones,
        },
        reason: null,
      }
    } finally {
      client.release()
    }
  },
})
