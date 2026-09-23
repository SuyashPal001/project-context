import { describe, it, expect, vi, beforeEach } from 'vitest'

const { refundVideoCharge } = vi.hoisted(() => ({ refundVideoCharge: vi.fn() }))
vi.mock('./videoCredits.js', () => ({ refundVideoCharge }))
const { refundImageCharge } = vi.hoisted(() => ({ refundImageCharge: vi.fn() }))
vi.mock('./imageCredits.js', () => ({ refundImageCharge }))

import { refundStaleBackgroundTask } from './backgroundTaskRefund.js'
import type { BackgroundTask } from '@mastra/core/background-tasks'

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 't1', status: 'failed', toolName: 'generate-video', toolCallId: 'tc-1',
    args: {}, agentId: 'director', threadId: 'conv-1', resourceId: 'tenant-1',
    runId: 'r1', retryCount: 0, maxRetries: 0, timeoutMs: 280_000, createdAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => vi.resetAllMocks())

describe('refundStaleBackgroundTask', () => {
  it('refunds a failed video task using a chargeKey built from threadId, toolCallId, and the hardcoded attempt suffix', async () => {
    await refundStaleBackgroundTask(task(), 'video')
    expect(refundVideoCharge).toHaveBeenCalledWith('tenant-1', undefined, 'video:conv-1:tc-1:0', null, null)
  })

  it('refunds a failed image task the same way, via refundImageCharge', async () => {
    await refundStaleBackgroundTask(task({ toolName: 'generate-image' }), 'image')
    expect(refundImageCharge).toHaveBeenCalledWith('tenant-1', undefined, 'image:conv-1:tc-1:0', null, null)
  })

  it('does nothing and logs when resourceId is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await refundStaleBackgroundTask(task({ resourceId: undefined }), 'video')
    expect(refundVideoCharge).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
