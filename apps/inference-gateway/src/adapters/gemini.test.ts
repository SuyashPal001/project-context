import { describe, it, expect } from 'vitest';
import { toGeminiParts, sanitizeSchema, toGeminiContents, SKIP_THOUGHT_SIGNATURE } from './gemini';

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

describe('toGeminiContents replays tool calls Gemini 3 will accept', () => {
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'generate_video', arguments: '{}' } });
  const sig = Buffer.from('real-sig', 'utf8').toString('base64url');

  it('gives an unsigned call the placeholder signature, or Gemini 3 400s the resume', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'make clip 1' },
      { role: 'assistant', content: null, tool_calls: [call('call_chatcmpl-1_1')] },
    ] as never);
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });

  it('keeps a real signature and adds no placeholder beside it', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'make clips' },
      { role: 'assistant', content: null, tool_calls: [call(`gs.${sig}.0`), call('call_chatcmpl-1_1')] },
    ] as never);
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe('real-sig');
    expect((contents[1].parts[1] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });
});
