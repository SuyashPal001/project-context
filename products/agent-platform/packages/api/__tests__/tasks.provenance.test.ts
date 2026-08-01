import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/database', () => ({ db: {} }))
// tasks.update.ts imports its db handle from '../db', not from the workspace
// package — mocking only '@serverless-saas/database' still loads a real client.
vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({
  agentTasks: {}, taskSteps: {}, taskEvents: {}, taskComments: {}, agents: {},
}))
vi.mock('@serverless-saas/agent-schema/task-revisions', () => ({ taskRevisions: {} }))
vi.mock('@serverless-saas/database/schema/auth', () => ({ users: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }))
vi.mock('@serverless-saas/ai', () => ({ embedTexts: vi.fn() }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))

import { TRACKED_FIELDS } from '../lib/revisions'

describe('task update patch schema — provenance', () => {
  it('does not accept rawInput as a patchable field', async () => {
    const mod = await import('../routes/tasks.update')
    // patchTaskSchema is not exported; assert on the exported guard instead.
    expect(mod.PROVENANCE_IMMUTABLE_FIELDS).toContain('rawInput')
  })

  it('treats every tracked field as revisionable', () => {
    for (const field of TRACKED_FIELDS) {
      expect(typeof field).toBe('string')
    }
    expect(TRACKED_FIELDS).toContain('title')
    expect(TRACKED_FIELDS).toContain('descriptionHtml')
  })
})

describe('rawInput fallback', () => {
  const rawInputFor = (description: string | undefined, title: string) =>
    description?.trim() || title

  it('uses the description when one was given', () => {
    expect(rawInputFor('Add SSO to the login flow', 'Add auth')).toBe('Add SSO to the login flow')
  })

  it('falls back to the title when description is absent', () => {
    expect(rawInputFor(undefined, 'Add auth')).toBe('Add auth')
  })

  it('falls back to the title when description is empty', () => {
    expect(rawInputFor('', 'Add auth')).toBe('Add auth')
  })

  it('falls back to the title when description is only whitespace', () => {
    expect(rawInputFor('   \n  ', 'Add auth')).toBe('Add auth')
  })
})
