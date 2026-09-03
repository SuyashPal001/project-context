import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing chatStream
vi.mock('@mastra/core/request-context', () => ({}))
vi.mock('../../persistence.js', () => ({}))
vi.mock('../../media.js', async () => {
  const actual = await vi.importActual<typeof import('../../media.js')>('../../media.js')
  return {
    downloadMediaAttachment: vi.fn(),
    buildAttachmentNote: actual.buildAttachmentNote,
  }
})
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

import { buildMastraMessage, attachmentFromCanvasToolResult } from '../chatStream.js'
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
    expect(text).toContain('analyze_audio')
    expect(text).toContain('video: "demo.mov" (fileId: v1)')
    expect(text).toContain('analyze_video')
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
    expect(finalText).toContain('analyze_audio')
    expect(finalText).toContain('analyze these')
  })
})

describe('attachmentFromCanvasToolResult', () => {
  it('a single turn producing two canvas outputs persists both, distinctly', () => {
    // Mirrors the runChatStream tool-result loop: one push per tool-result,
    // onto the same pendingAttachments array, across the whole turn.
    const pendingAttachments: ReturnType<typeof attachmentFromCanvasToolResult>[] = []

    const first = attachmentFromCanvasToolResult('render-canvas', {
      fileId: 'file-1', name: 'Q3 Analysis.md', fileType: 'text/markdown', size: 100,
    })
    const second = attachmentFromCanvasToolResult('render-canvas', {
      fileId: 'file-2', name: 'Q3 Analysis.md', fileType: 'text/markdown', size: 200,
    })
    if (first) pendingAttachments.push(first)
    if (second) pendingAttachments.push(second)

    expect(pendingAttachments).toHaveLength(2)
    expect(pendingAttachments).toEqual([
      { fileId: 'file-1', name: 'Q3 Analysis.md', type: 'text/markdown', size: 100 },
      { fileId: 'file-2', name: 'Q3 Analysis.md', type: 'text/markdown', size: 200 },
    ])
    // Neither entry overwrote or deduped the other, even with identical titles/names.
    const fileIds = pendingAttachments.map((a) => a?.fileId)
    expect(new Set(fileIds).size).toBe(2)
  })

  it('returns null for a non-canvas tool result', () => {
    expect(attachmentFromCanvasToolResult('save-prd', { fileId: 'file-1' })).toBeNull()
  })

  it('returns null when the canvas tool result has no fileId (upload failed)', () => {
    expect(attachmentFromCanvasToolResult('render-canvas', { title: 'x' })).toBeNull()
  })
})

describe('attachmentFromCanvasToolResult — generate-image/edit-image', () => {
  it('turns a generate-image tool result into an attachment, same as render-canvas', () => {
    const result = { fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 100 }
    expect(attachmentFromCanvasToolResult('generate-image', result)).toEqual({
      fileId: 'f1', name: 'x.png', type: 'image/png', size: 100,
    })
  })

  it('turns an edit-image tool result into an attachment', () => {
    const result = { fileId: 'f2', name: 'y.png', fileType: 'image/png', size: 200 }
    expect(attachmentFromCanvasToolResult('edit-image', result)).toEqual({
      fileId: 'f2', name: 'y.png', type: 'image/png', size: 200,
    })
  })

  it('still returns null for an unrelated tool name', () => {
    expect(attachmentFromCanvasToolResult('fetch-agent-context', { fileId: 'f3' })).toBeNull()
  })
})

describe('attachmentFromCanvasToolResult — generate-song', () => {
  it('returns an attachment payload for a generate-song result with a fileId', () => {
    const result = attachmentFromCanvasToolResult('generate-song', { fileId: 'f1', name: 'song.wav', fileType: 'audio/wav', size: 100 })
    expect(result).toEqual({ fileId: 'f1', name: 'song.wav', type: 'audio/wav', size: 100 })
  })

  it('returns null for a generate-song result with no fileId (refusal)', () => {
    const result = attachmentFromCanvasToolResult('generate-song', { refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(result).toBeNull()
  })
})

describe('attachmentFromCanvasToolResult — generate-video', () => {
  it('returns an attachment payload for a generate-video result with a fileId', () => {
    const result = attachmentFromCanvasToolResult('generate-video', { fileId: 'f1', name: 'clip.mp4', fileType: 'video/mp4', size: 100 })
    expect(result).toEqual({ fileId: 'f1', name: 'clip.mp4', type: 'video/mp4', size: 100 })
  })

  it('returns null for a generate-video result with no fileId (refusal)', () => {
    const result = attachmentFromCanvasToolResult('generate-video', { refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(result).toBeNull()
  })
})
