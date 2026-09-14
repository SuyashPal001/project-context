import { describe, it, expect } from 'vitest';
import { getAdapterChain, getPrivateOnlyChain } from './router';

describe('getAdapterChain', () => {
  it('routes openrouter/* models to the OpenRouter adapter only, no fallback', () => {
    const chain = getAdapterChain('openrouter/anthropic/claude-opus-5');
    expect(chain).toHaveLength(1);
    expect((chain[0] as { adapterName?: string }).adapterName).toBe('openrouter');
  });

  it('still routes claude-* models to Anthropic then Ollama, unaffected', () => {
    const chain = getAdapterChain('claude-sonnet-4-5');
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).toEqual(['anthropic', 'ollama']);
  });

  it('does not put openrouter in the default (Gemini) chain', () => {
    const chain = getAdapterChain('gemini-2.5-flash');
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).not.toContain('openrouter');
  });

  it('tries Gemini API before Vertex on the default (Gemini) chain', () => {
    // See images.ts/video.ts — Vertex 404ing on the project was silently eating
    // undici's headers-timeout on every chat turn before the Gemini API fallback
    // ran, killing mid-conversation state.
    const chain = getAdapterChain('gemini-2.5-flash');
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    const geminiIdx = names.indexOf('gemini');
    const vertexIdx = names.indexOf('vertex');
    if (geminiIdx !== -1) expect(geminiIdx).toBeLessThan(vertexIdx);
    expect(vertexIdx).toBeGreaterThan(-1);
    expect(names[names.length - 1]).toBe('ollama');
  });
});

describe('getPrivateOnlyChain', () => {
  it('never includes openrouter — restricted data must stay on Ollama', () => {
    const chain = getPrivateOnlyChain();
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).toEqual(['ollama']);
  });
});
