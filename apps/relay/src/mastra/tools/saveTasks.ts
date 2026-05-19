import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'
import { randomUUID } from 'crypto'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[saveTasks] pool error:', err.message)
    })
  }
  return _pool
}

const taskItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  estimatedHours: z.number().optional(),
})

const milestoneTaskDataSchema = z.object({
  milestoneId: z.string(),
  milestoneName: z.string(),
  tasks: z.array(taskItemSchema),
})

const taskDataSchema = z.object({
  planId: z.string(),
  milestones: z.array(milestoneTaskDataSchema),
})

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const saveTasks = createTool({
  id: 'save-tasks',
  description: 'Inserts agent_tasks rows for all milestones in the task generation output. Wraps all inserts in a single transaction.',
  requestContextSchema,
  inputSchema: z.object({
    taskData: taskDataSchema,
  }),
  outputSchema: z.object({
    tasksCreated: z.number(),
    milestoneCount: z.number(),
  }),
  execute: async (inputData, execContext) => {
    const taskData = (inputData as any)?.taskData
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const userId   = execContext?.requestContext?.get('userId')   as string | undefined ?? ''
    const agentId  = execContext?.requestContext?.get('agentId')  as string | undefined ?? ''
    const { planId, milestones } = taskData
    const client = await getPool().connect()

    try {
      await client.query('BEGIN')

      let tasksCreated = 0

      for (const milestone of milestones) {
        const { milestoneId, tasks } = milestone

        // Batch insert all tasks for this milestone in one query
        if (tasks.length === 0) continue

        const values: unknown[] = []
        const placeholders: string[] = []
        let p = 1

        for (const task of tasks) {
          // Convert string[] AC → { text, checked: false }[] before storing as JSONB
          const ac = task.acceptanceCriteria.map((text) => ({ text, checked: false }))

          placeholders.push(
            `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,$${p++},$${p++},'backlog',$${p++},$${p++},NOW(),NOW())`,
          )
          values.push(
            randomUUID(),           // id
            tenantId,               // tenant_id
            userId,                 // created_by
            agentId,                // agent_id
            task.title,             // title
            task.description,       // description
            JSON.stringify(ac),     // acceptance_criteria (jsonb)
            task.priority,          // priority
            task.estimatedHours != null ? String(task.estimatedHours) : null, // estimated_hours
            planId,                 // plan_id
            milestoneId,            // milestone_id
          )
        }

        await client.query(
          `INSERT INTO agent_tasks
             (id, tenant_id, created_by, agent_id, title, description,
              acceptance_criteria, priority, estimated_hours, status,
              plan_id, milestone_id, created_at, updated_at)
           VALUES ${placeholders.join(',')}`,
          values,
        )

        tasksCreated += tasks.length
      }

      await client.query('COMMIT')
      console.log(`[saveTasks] created tasks=${tasksCreated} milestones=${milestones.length} planId=${planId} tenant=${tenantId}`)

      return { tasksCreated, milestoneCount: milestones.length }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  },
})
