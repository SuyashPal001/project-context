import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

const { launch, page, browser } = vi.hoisted(() => {
  const page = {
    setViewport: vi.fn(), goto: vi.fn(), evaluate: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  }
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) }
  const launch = vi.fn().mockResolvedValue(browser)
  return { launch, page, browser }
})
vi.mock('puppeteer', () => ({ default: { launch } }))

import { captureWebpage, inputSchema } from './captureWebpage.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.clearAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('captureWebpage input schema', () => {
  it('rejects a non-URL string', () => {
    expect(inputSchema.safeParse({ url: 'not-a-url' }).success).toBe(false)
  })
  it('defaults width/height to 1920x1080', () => {
    const res = inputSchema.safeParse({ url: 'https://example.com' })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toMatchObject({ width: 1920, height: 1080 })
  })
})

describe('captureWebpage tool', () => {
  it('navigates, runs the redaction script before the screenshot, and uploads the result', async () => {
    vi.mocked(uploadGeneratedFile).mockResolvedValue({ fileId: 'f1', name: 'Webpage Capture', type: 'image/png', size: 9 } as never)

    const result = await captureWebpage.execute!({ url: 'https://example.com/portal', width: 1920, height: 1080 } as never, baseCtx())

    expect(launch).toHaveBeenCalled()
    expect(page.goto).toHaveBeenCalledWith('https://example.com/portal', expect.objectContaining({ waitUntil: 'networkidle2' }))
    const evaluateOrder = page.evaluate.mock.invocationCallOrder[0]
    const screenshotOrder = page.screenshot.mock.invocationCallOrder[0]
    expect(evaluateOrder).toBeLessThan(screenshotOrder)
    expect(page.evaluate.mock.calls[0][0]).toContain('ipRe')
    expect(browser.close).toHaveBeenCalled()
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ fileId: 'f1' })
  })

  it('refunds the charge and closes the browser when navigation fails', async () => {
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'))
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await captureWebpage.execute!({ url: 'https://nonexistent.example', width: 1920, height: 1080 } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'CAPTURE_FAILED' })
    expect(browser.close).toHaveBeenCalled()
    expect(spendCredits).toHaveBeenCalledTimes(2) // charge, then refund
  })
})
