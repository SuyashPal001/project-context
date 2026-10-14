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

import { buildGeminiRequest } from './vertex';

describe('toGeminiParts input_video (vertex)', () => {
  it('inline base64 video becomes inlineData with videoMetadata.fps', () => {
    const parts = toGeminiParts([{ type: 'input_video', input_video: { data: 'AAAA', fps: 4 } }]);
    expect(parts).toEqual([{ inlineData: { mimeType: 'video/mp4', data: 'AAAA' }, videoMetadata: { fps: 4 } }]);
  });
  it('a YouTube URL becomes fileData', () => {
    const parts = toGeminiParts([{ type: 'input_video', input_video: { url: 'https://www.youtube.com/watch?v=x', fps: 2 } }]);
    expect(parts).toEqual([{ fileData: { mimeType: 'video/mp4', fileUri: 'https://www.youtube.com/watch?v=x' }, videoMetadata: { fps: 2 } }]);
  });
  it('a video part with neither data nor url is dropped', () => {
    expect(toGeminiParts([{ type: 'input_video', input_video: {} }])).toEqual([]);
  });
  it('thinkingLevel maps to generationConfig.thinkingConfig.thinkingLevel', () => {
    const req = buildGeminiRequest({ messages: [{ role: 'user', content: 'hi' }], thinkingLevel: 'LOW' });
    expect(req.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' } });
  });
});
