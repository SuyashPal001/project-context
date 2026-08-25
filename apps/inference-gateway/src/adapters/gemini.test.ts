import { describe, it, expect } from 'vitest';
import { toGeminiParts } from './gemini';

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
