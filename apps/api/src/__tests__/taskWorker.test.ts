import { describe, it, expect, vi } from 'vitest'

// vi.hoisted runs before imports — use it to create mock state that vi.mock factories
// can close over. This is necessary because vi.mock factories are hoisted above imports
// but cannot reference module-level variables (they're in a different scope).
const mockDb = vi.hoisted(() => {
  const obj: any = {}
  obj.query = { agentTasks: { findFirst: vi.fn() } }
  obj.select = vi.fn().mockReturnValue(obj)
  obj.from = vi.fn().mockReturnValue(obj)
  obj.where = vi.fn().mockReturnValue(obj)
  obj.limit = vi.fn().mockResolvedValue([])
  obj.update = vi.fn().mockReturnValue(obj)
  obj.set = vi.fn().mockReturnValue(obj)
  obj.delete = vi.fn().mockReturnValue(obj)
  obj.insert = vi.fn().mockReturnValue(obj)
  obj.values = vi.fn().mockResolvedValue([])
  obj.returning = vi.fn().mockResolvedValue([])
  return obj
})

// Intercept the module-level `const db = drizzle(neon(process.env.DATABASE_URL!), { schema })`
// in taskWorker.ts so it never tries to open a real DB connection.
vi.mock('@serverless-saas/database', () => ({ db: mockDb }))
vi.mock('@neondatabase/serverless', () => ({ neon: vi.fn() }))
vi.mock('drizzle-orm/neon-http', () => ({ drizzle: vi.fn(() => mockDb) }))
vi.mock('@serverless-saas/database/schema', () => ({
  agentTasks: {}, taskSteps: {}, taskEvents: {}, agents: {}, files: {},
}))
vi.mock('@serverless-saas/storage', () => ({
  storageService: { downloadFile: vi.fn() },
}))
vi.mock('pdf-parse', () => ({ default: vi.fn().mockResolvedValue({ text: '' }) }))
vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: '' }) },
}))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))
vi.mock('../lib/sqs', () => ({ publishToQueue: vi.fn() }))
vi.mock('../lib/secrets', () => ({ initRuntimeSecrets: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@serverless-saas/cache', () => ({ getCacheClient: vi.fn() }))
vi.mock('@serverless-saas/ai', () => ({ embedQuery: vi.fn() }))
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  return { ...actual, eq: vi.fn(() => ({})), and: vi.fn(() => ({})), asc: vi.fn(() => ({})), inArray: vi.fn(() => ({})) }
})

import { handler } from '../workers/taskWorker'
import type { SQSEvent } from 'aws-lambda'

function makeEvent(body: object): SQSEvent {
  return { Records: [{ body: JSON.stringify(body), messageId: '1', receiptHandle: '', attributes: {} as any, messageAttributes: {}, md5OfBody: '', eventSource: '', eventSourceARN: '', awsRegion: '' }] }
}

describe('taskWorker handler — vi.hoisted DB mock', () => {
  it('resolves without error for an unrecognised message type', async () => {
    const event = makeEvent({ type: 'unknown_type', taskId: 'tid-1' })
    await expect(handler(event, {} as any, vi.fn() as any)).resolves.toBeUndefined()
  })

  it('rejects with Task not found when plan_task references a missing task', async () => {
    mockDb.query.agentTasks.findFirst.mockResolvedValue(null)
    const event = makeEvent({ type: 'plan_task', taskId: 'nonexistent-id' })
    await expect(handler(event, {} as any, vi.fn() as any)).rejects.toThrow('Task not found: nonexistent-id')
  })
})
