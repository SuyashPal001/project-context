import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

import { analyzeImageTool } from './analyzeImage.js'
import { fetchPresignedUrl } from './mediaCache.js'

describe('analyzeImageTool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns success:false with no idToken/sessionId', async () => {
    const result = await analyzeImageTool.execute!(
      { fileId: 'f1', question: 'Does this spell ACME correctly?' },
      { requestContext: { get: () => undefined } } as never,
    )
    expect(result).toEqual({ success: false, error: 'no_active_session' })
  })

  it('asks the gateway and returns its answer', async () => {
    vi.mocked(fetchPresignedUrl).mockResolvedValue('https://example.com/img.png')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: { get: () => 'image/png' } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'Yes, spelled correctly.' } }] }) }) as never

    const result = await analyzeImageTool.execute!(
      { fileId: 'f1', question: 'Does this spell ACME correctly?' },
      { requestContext: { get: (k: string) => ({ idToken: 'tok', sessionId: 's1' } as Record<string, string>)[k] } } as never,
    )
    expect(result).toEqual({ success: true, answer: 'Yes, spelled correctly.' })
  })
})
