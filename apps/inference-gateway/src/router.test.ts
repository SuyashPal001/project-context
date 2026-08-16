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
});

describe('getPrivateOnlyChain', () => {
  it('never includes openrouter — restricted data must stay on Ollama', () => {
    const chain = getPrivateOnlyChain();
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).toEqual(['ollama']);
  });
});
