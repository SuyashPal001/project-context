import { randomUUID } from 'crypto'
import pg from 'pg'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrdTask {
  title: string
  description: string
  acceptanceCriteria: string[]
  priority: 'low' | 'medium' | 'high' | 'urgent'
  estimatedHours?: number
  type: 'feature' | 'bug' | 'chore' | 'spike'
}

export interface PrdMilestone {
  title: string
  description: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  targetDate?: string
  tasks: PrdTask[]
}

export interface PrdData {
  plan: {
    title: string
    description: string
    targetDate?: string
  }
  milestones: PrdMilestone[]
  risks: string[]
  totalEstimatedHours?: number
}

export interface PlanCreateResult {
  planId: string
  planSequenceId: string
  milestoneCount: number
  taskCount: number
  planUrl: string
}

// ─── Private helpers ──────────────────────────────────────────────────────────

let _planPool: pg.Pool | null = null

function getPlanPool(): pg.Pool {
  if (!_planPool) {
    _planPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _planPool.on('error', (err) => {
      console.error('[planService] pool error:', err.message)
    })
  }
  return _planPool
}

async function planNextSeq(
  client: pg.PoolClient,
  tenantId: string,
  resource: 'plan' | 'milestone',
): Promise<number> {
  const { rows } = await client.query<{ last_seq: number }>(
    `INSERT INTO tenant_counters (tenant_id, resource, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, resource)
     DO UPDATE SET last_seq = tenant_counters.last_seq + 1
     RETURNING last_seq`,
    [tenantId, resource],
  )
  return rows[0].last_seq
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createPlanFromPrd(
  tenantId: string,
  userId: string,
  prdData: PrdData,
): Promise<PlanCreateResult> {
  const { plan, milestones } = prdData
  const client = await getPlanPool().connect()

  try {
    await client.query('BEGIN')

    // 1. Plan row
    const planId = randomUUID()
    const planSeq = await planNextSeq(client, tenantId, 'plan')
    await client.query(
      `INSERT INTO project_plans
         (id, tenant_id, sequence_id, title, description, status, target_date, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, NOW(), NOW())`,
      [
        planId, tenantId, planSeq,
        plan.title, plan.description ?? null,
        plan.targetDate ? new Date(plan.targetDate) : null,
        userId,
      ],
    )

    let milestoneCount = 0
    let taskCount = 0

    for (const milestone of milestones) {
      // 2. Milestone row
      const milestoneId = randomUUID()
      const milestoneSeq = await planNextSeq(client, tenantId, 'milestone')
      const allAC = (milestone.tasks ?? []).flatMap(t => t.acceptanceCriteria ?? [])
      const totalHours = (milestone.tasks ?? []).reduce((sum, t) => sum + (t.estimatedHours ?? 0), 0)
      await client.query(
        `INSERT INTO project_milestones
           (id, tenant_id, plan_id, sequence_id, title, description, status, priority, target_date, created_by, acceptance_criteria, estimated_hours, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'backlog', $7, $8, $9, $10::jsonb, $11, NOW(), NOW())`,
        [
          milestoneId, tenantId, planId, milestoneSeq,
          milestone.title, milestone.description ?? null,
          milestone.priority ?? 'medium',
          milestone.targetDate ? new Date(milestone.targetDate) : null,
          userId,
          JSON.stringify(allAC),
          totalHours > 0 ? String(totalHours) : null,
        ],
      )
      milestoneCount++

      // 3. Task rows — batched 50 at a time
      const tasks = milestone.tasks ?? []
      for (let i = 0; i < tasks.length; i += 50) {
        const batch = tasks.slice(i, i + 50)
        const values: unknown[] = []
        const placeholders: string[] = []
        let p = 1
        for (const task of batch) {
          placeholders.push(
            `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,$${p++},$${p++},'backlog',$${p++},$${p++},NOW(),NOW())`,
          )
          values.push(
            randomUUID(), tenantId, userId,
            task.title, task.description ?? null,
            JSON.stringify((task.acceptanceCriteria ?? []).map(s => ({ text: s, checked: false }))),
            task.priority ?? 'medium',
            task.estimatedHours != null ? String(task.estimatedHours) : null,
            planId, milestoneId,
          )
        }
        await client.query(
          `INSERT INTO agent_tasks
             (id, tenant_id, created_by, title, description, acceptance_criteria,
              priority, estimated_hours, status, plan_id, milestone_id, created_at, updated_at)
           VALUES ${placeholders.join(',')}`,
          values,
        )
        taskCount += batch.length
      }
    }

    await client.query('COMMIT')
    console.log(`[planService] created planId=${planId} milestones=${milestoneCount} tasks=${taskCount} tenant=${tenantId}`)

    return {
      planId,
      planSequenceId: `PLN-${planSeq}`,
      milestoneCount,
      taskCount,
      planUrl: `/dashboard/plans/${planId}`,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
