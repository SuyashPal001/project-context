import { describe, it, expect } from 'vitest';
import { toGeminiParts } from './vertex';

describe('toGeminiParts (vertex)', () => {
  it('translates an input_audio block to inlineData with an audio mimeType', () => {
    const parts = toGeminiParts([
      { type: 'input_audio', input_audio: { data: 'ZmFrZWF1ZGlv', format: 'mp3' } },
    ]);
    expect(parts).toEqual([
      { inlineData: { mimeType: 'audio/mp3', data: 'ZmFrZWF1ZGlv' } },
    ]);
  });

  it('still translates text and image_url blocks unchanged', () => {
    const parts = toGeminiParts([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]);
    expect(parts).toEqual([
      { text: 'hello' },
      { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ]);
  });
});
