import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}))

vi.mock('../db', () => ({ db: mockDb }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({
  agentTasks: { id: 'agentTasks.id', tenantId: 'agentTasks.tenantId' },
  taskSteps: { taskId: 'taskSteps.taskId', tenantId: 'taskSteps.tenantId', stepNumber: 'taskSteps.stepNumber' },
  taskComments: { taskId: 'taskComments.taskId', tenantId: 'taskComments.tenantId', authorId: 'taskComments.authorId', authorType: 'taskComments.authorType', createdAt: 'taskComments.createdAt' },
  agents: { id: 'agents.id', name: 'agents.name' },
}))
vi.mock('@serverless-saas/agent-schema/pm', () => ({
  projectPlans: { id: 'projectPlans.id' },
}))
vi.mock('@serverless-saas/agent-schema/github', () => ({
  githubRepos: { id: 'githubRepos.id' },
}))
vi.mock('@serverless-saas/database/schema/auth', () => ({
  users: { id: 'users.id', name: 'users.name' },
}))

import { registerAgentPlatformMcpTools, __resetRegisteredFlagForTests } from '../mcp/tools'
import { getMcpRegistry, resetMcpRegistry } from '@serverless-saas/mcp'

const AUTH = { tenantId: 'tenant-1', keyId: 'key-1', keyType: 'agent' as const, permissions: ['agent_tasks:read'] }

// Builds a chainable query mock: db.select().from().where().limit()/.orderBy()/.leftJoin() -> resolves to `rows`.
// When `whereArgs` is supplied, every argument passed to `.where()` is pushed onto it, so callers
// can assert on the *actual* drizzle condition object built by the handler (real `eq`/`and` from
// drizzle-orm, not mocked) -- this is what lets a test fail if a tenantId filter is later removed.
function chain(rows: unknown[], whereArgs?: unknown[]) {
  const q: any = {}
  q.from = vi.fn(() => q)
  q.leftJoin = vi.fn(() => q)
  q.where = vi.fn((cond: unknown) => {
    whereArgs?.push(cond)
    return q
  })
  q.orderBy = vi.fn(() => Promise.resolve(rows))
  q.limit = vi.fn(() => Promise.resolve(rows))
  return q
}

// Recursively walks a drizzle SQL condition object (as produced by real `eq`/`and`) looking for a
// raw string equal to `columnRef`. Our schema mocks represent columns as plain strings (e.g.
// 'taskSteps.tenantId'), so if a handler's `.where()` predicate stops referencing a column, that
// string disappears from the condition's queryChunks tree and this returns false.
function conditionReferencesColumn(cond: unknown, columnRef: string, seen = new Set<unknown>()): boolean {
  if (cond == null) return false
  if (typeof cond === 'string') return cond === columnRef
  if (typeof cond !== 'object') return false
  if (seen.has(cond)) return false
  seen.add(cond)
  if (Array.isArray(cond)) return cond.some((c) => conditionReferencesColumn(c, columnRef, seen))
  for (const key of Object.keys(cond as Record<string, unknown>)) {
    if (key === 'decoder') continue
    if (conditionReferencesColumn((cond as Record<string, unknown>)[key], columnRef, seen)) return true
  }
  return false
}

beforeEach(() => {
  resetMcpRegistry()
  __resetRegisteredFlagForTests()
  registerAgentPlatformMcpTools()
  mockDb.select.mockReset()
})

describe('start_task tool', () => {
  it('returns Task not found when task does not belong to tenant', async () => {
    mockDb.select.mockReturnValueOnce(chain([])) // task lookup returns nothing
    const result = await getMcpRegistry().execute({ name: 'start_task', arguments: { taskId: 't1' } }, AUTH)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Task not found')
  })

  it('returns task, plan steps, project context, and repo ref when found', async () => {
    const task = {
      id: 't1', title: 'Fix bug', description: 'desc', status: 'ready', priority: 'high',
      acceptanceCriteria: [], planApprovedAt: new Date('2026-01-01'), planApprovedBy: 'u1',
      planId: 'plan-1', repoId: 'repo-1',
    }
    const stepsWhereArgs: unknown[] = []
    mockDb.select
      .mockReturnValueOnce(chain([task]))                 // task lookup
      .mockReturnValueOnce(chain([{ id: 's1', stepNumber: 1, title: 'Step 1', status: 'done' }], stepsWhereArgs)) // steps
      .mockReturnValueOnce(chain([{ id: 'plan-1', title: 'Q1 Plan', description: 'plan desc', context: 'workspace notes' }])) // project
      .mockReturnValueOnce(chain([{ id: 'repo-1', repoFullName: 'acme/widget', defaultBranch: 'main' }])) // repo

    const result = await getMcpRegistry().execute({ name: 'start_task', arguments: { taskId: 't1' } }, AUTH)
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text as string)
    expect(payload.task.id).toBe('t1')
    expect(payload.plan.approved).toBe(true)
    expect(payload.plan.steps).toHaveLength(1)
    expect(payload.project).toEqual({ id: 'plan-1', title: 'Q1 Plan', description: 'plan desc', context: 'workspace notes' })
    expect(payload.repo).toEqual({ fullName: 'acme/widget', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/widget.git' })

    // Tenant isolation: the steps query must filter on both taskId and tenantId. If a future
    // change drops `eq(taskSteps.tenantId, ...)` from the handler's `.where()`, this fails.
    expect(stepsWhereArgs).toHaveLength(1)
    expect(conditionReferencesColumn(stepsWhereArgs[0], 'taskSteps.taskId')).toBe(true)
    expect(conditionReferencesColumn(stepsWhereArgs[0], 'taskSteps.tenantId')).toBe(true)
  })

  it('returns null project/repo when task has no planId/repoId', async () => {
    const task = {
      id: 't1', title: 'Fix bug', description: null, status: 'ready', priority: 'medium',
      acceptanceCriteria: [], planApprovedAt: null, planApprovedBy: null, planId: null, repoId: null,
    }
    mockDb.select
      .mockReturnValueOnce(chain([task])) // task lookup
      .mockReturnValueOnce(chain([]))     // steps

    const result = await getMcpRegistry().execute({ name: 'start_task', arguments: { taskId: 't1' } }, AUTH)
    const payload = JSON.parse(result.content[0].text as string)
    expect(payload.project).toBeNull()
    expect(payload.repo).toBeNull()
    expect(payload.plan.approved).toBe(false)
  })
})

describe('get_task_thread tool', () => {
  it('returns Task not found when task does not belong to tenant', async () => {
    mockDb.select.mockReturnValueOnce(chain([]))
    const result = await getMcpRegistry().execute({ name: 'get_task_thread', arguments: { taskId: 't1' } }, AUTH)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Task not found')
  })

  it('returns ordered comments when task exists', async () => {
    const commentsWhereArgs: unknown[] = []
    mockDb.select
      .mockReturnValueOnce(chain([{ id: 't1' }])) // task lookup
      .mockReturnValueOnce(chain([{ id: 'c1', content: 'hello', authorName: 'Ada', createdAt: new Date('2026-01-01') }], commentsWhereArgs)) // comments

    const result = await getMcpRegistry().execute({ name: 'get_task_thread', arguments: { taskId: 't1' } }, AUTH)
    const payload = JSON.parse(result.content[0].text as string)
    expect(payload.comments).toHaveLength(1)
    expect(payload.comments[0].content).toBe('hello')

    // Tenant isolation: the comments query must filter on both taskId and tenantId. If a future
    // change drops `eq(taskComments.tenantId, ...)` from the handler's `.where()`, this fails.
    expect(commentsWhereArgs).toHaveLength(1)
    expect(conditionReferencesColumn(commentsWhereArgs[0], 'taskComments.taskId')).toBe(true)
    expect(conditionReferencesColumn(commentsWhereArgs[0], 'taskComments.tenantId')).toBe(true)
  })
})

describe('permission enforcement', () => {
  it('denies start_task without agent_tasks:read permission', async () => {
    const result = await getMcpRegistry().execute(
      { name: 'start_task', arguments: { taskId: 't1' } },
      { ...AUTH, permissions: [] },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Permission denied')
  })
})
