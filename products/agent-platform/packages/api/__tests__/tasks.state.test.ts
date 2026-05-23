import { describe, it, expect, vi } from 'vitest'

// Prevent module-level side effects from tasks.ts's workspace imports.
// vi.mock is hoisted before all imports by vitest.
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({
  agentTasks: {}, taskSteps: {}, taskEvents: {}, taskComments: {}, agents: {},
}))
vi.mock('@serverless-saas/database/schema/auth', () => ({ users: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(false) }))
vi.mock('@serverless-saas/ai', () => ({ embedTexts: vi.fn() }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))

import { VALID_USER_TRANSITIONS } from '../routes/tasks'

describe('VALID_USER_TRANSITIONS — state machine', () => {
  it('planning allows no user-initiated transitions', () => {
    expect(VALID_USER_TRANSITIONS.planning).toEqual([])
  })

  it('awaiting_approval allows no user-initiated transitions', () => {
    expect(VALID_USER_TRANSITIONS.awaiting_approval).toEqual([])
  })

  it('done allows no user-initiated transitions', () => {
    expect(VALID_USER_TRANSITIONS.done).toEqual([])
  })

  it('backlog can move to todo or cancelled', () => {
    expect(VALID_USER_TRANSITIONS.backlog).toContain('todo')
    expect(VALID_USER_TRANSITIONS.backlog).toContain('cancelled')
  })

  it('review can move to done or cancelled', () => {
    expect(VALID_USER_TRANSITIONS.review).toContain('done')
    expect(VALID_USER_TRANSITIONS.review).toContain('cancelled')
  })

  it('planning → done is explicitly not a valid user transition', () => {
    expect(VALID_USER_TRANSITIONS.planning.includes('done')).toBe(false)
  })
})
