import { describe, it, expect, vi } from 'vitest'
import { classifyGeminiImageResponse } from './images'

describe('classifyGeminiImageResponse', () => {
  it('extracts inline image bytes from a normal candidate', () => {
    const geminiResponse = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
      }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      imageBase64: 'QUJD',
      mimeType: 'image/png',
    })
  })

  it('classifies a SAFETY finishReason as a refusal, not a throw', () => {
    const geminiResponse = {
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      refused: true,
      reason: 'SAFETY',
    })
  })

  it('classifies an empty candidate list as a refusal', () => {
    expect(classifyGeminiImageResponse({ candidates: [] })).toEqual({
      refused: true,
      reason: 'NO_CANDIDATES',
    })
  })
})
