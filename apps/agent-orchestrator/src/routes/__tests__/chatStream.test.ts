import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing chatStream
vi.mock('@mastra/core/request-context', () => ({}))
vi.mock('../../persistence.js', () => ({}))
vi.mock('../../media.js', () => ({
  downloadMediaAttachment: vi.fn(),
}))
vi.mock('../../events.js', () => ({}))
vi.mock('../../mastra/registry.js', () => ({}))
vi.mock('../../mastra/guardrails.js', () => ({}))
vi.mock('../../fairness/index.js', () => ({}))
vi.mock('../../mastra/tools.js', () => ({}))
vi.mock('../../mastra/thinking.js', () => ({}))
vi.mock('../../mastra/cost.js', () => ({}))
vi.mock('../../usage.js', () => ({}))
vi.mock('../../mastra/model.js', () => ({}))
vi.mock('../../llm/quickCall.js', () => ({}))
vi.mock('@serverless-saas/ai', () => ({}))
vi.mock('@serverless-saas/database', () => ({ db: {} }))

import { buildMastraMessage } from '../chatStream.js'
import { downloadMediaAttachment } from '../../media.js'
import type { Attachment } from '../../types.js'

describe('buildMastraMessage', () => {
  beforeEach(() => {
    vi.mocked(downloadMediaAttachment).mockClear()
  })

  it('returns the plain message when there are no attachments', async () => {
    const result = await buildMastraMessage([], '', '', 'hello', 'session-1')
    expect(result).toBe('hello')
  })

  it('appends an attachment-discovery note for audio and video, without downloading them', async () => {
    const attachments: Attachment[] = [
      { fileId: 'a1', name: 'voice-memo.mp3', type: 'audio/mpeg' },
      { fileId: 'v1', name: 'demo.mov', type: 'video/quicktime' },
    ]
    const result = await buildMastraMessage(attachments, '', '', 'what is in these?', 'session-1')
    expect(typeof result).toBe('string')
    const text = result as string
    expect(text).toContain('what is in these?')
    expect(text).toContain('audio: "voice-memo.mp3" (fileId: a1)')
    expect(text).toContain('analyzeAudio')
    expect(text).toContain('video: "demo.mov" (fileId: v1)')
    expect(text).toContain('analyzeVideo')
  })

  it('omits the attachments block entirely when there are none', async () => {
    const result = await buildMastraMessage([], '', '', 'hello', 'session-1')
    expect(result as string).not.toContain('<attachments>')
  })

  it('preserves the attachment-discovery note when processing mixed image + audio attachments', async () => {
    // Mock downloadMediaAttachment to return a fake image for the image attachment
    vi.mocked(downloadMediaAttachment).mockResolvedValueOnce({
      filePath: '/tmp/photo.png',
      base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      name: 'photo.png',
    })

    const attachments: Attachment[] = [
      { fileId: 'img1', name: 'photo.png', type: 'image/png' },
      { fileId: 'a1', name: 'voice-memo.mp3', type: 'audio/mpeg' },
    ]
    const result = await buildMastraMessage(attachments, '', '', 'analyze these', 'session-1')

    // The result should be the complex return type (image + text content parts)
    expect(result).toBeDefined()

    // Extract the text content from the result
    let finalText = ''
    if (typeof result === 'string') {
      finalText = result
    } else if (result && typeof result === 'object' && 'content' in result) {
      // Find the text part in the content array
      const textPart = (result as any).content.find((p: any) => p.type === 'text')
      if (textPart) finalText = textPart.text
    }

    // Assert the attachment note survived through the image processing path
    expect(finalText).toContain('audio: "voice-memo.mp3" (fileId: a1)')
    expect(finalText).toContain('analyzeAudio')
    expect(finalText).toContain('analyze these')
  })
})
