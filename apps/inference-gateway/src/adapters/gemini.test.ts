import { describe, it, expect } from 'vitest';
import { toGeminiParts, sanitizeSchema } from './gemini';

describe('toGeminiParts (gemini)', () => {
  it('translates an input_audio block to inlineData with an audio mimeType', () => {
    const parts = toGeminiParts([
      { type: 'input_audio', input_audio: { data: 'ZmFrZWF1ZGlv', format: 'mp3' } },
    ]);
    expect(parts).toEqual([
      { inlineData: { mimeType: 'audio/mp3', data: 'ZmFrZWF1ZGlv' } },
    ]);
  });
});

describe('sanitizeSchema (gemini)', () => {
  it('drops empty properties on an object schema — Gemini 400s on `properties:{}`', () => {
    const cleaned = sanitizeSchema({ type: 'object', properties: {} }) as Record<string, unknown>;
    expect(cleaned).toEqual({ type: 'object' });
  });

  it('keeps non-empty properties intact', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    }) as Record<string, unknown>;
    expect(cleaned).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('recursively drops empty properties on nested object schemas', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      properties: {
        payload: { type: 'object', properties: {} },
      },
    }) as Record<string, unknown>;
    expect(cleaned).toEqual({
      type: 'object',
      properties: { payload: { type: 'object' } },
    });
  });
});
