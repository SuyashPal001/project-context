import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { OpenRouterAdapter } from './openrouter';
import { AdapterError } from './base';
import type { OpenAIRequest } from '../types';

function createMockRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let ended = false;
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { statusCode = code; headers = h ?? {}; },
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); ended = true; },
    headersSent: false,
  };
  return {
    res: res as unknown as ServerResponse,
    get chunks() { return chunks; },
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    get ended() { return ended; },
  };
}

const baseReq: OpenAIRequest = {
  model: 'openrouter/anthropic/claude-opus-5',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenRouterAdapter', () => {
  const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it('fails fast with no network call when OPENROUTER_API_KEY is unset', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await expect(adapter.handleCompletion(baseReq, res)).rejects.toThrow(AdapterError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strips the openrouter/ prefix and forwards to the OpenRouter API with auth + attribution headers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'x', object: 'chat.completion', choices: [], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await adapter.handleCompletion(baseReq, res);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer test-key');
    expect(init.headers['HTTP-Referer']).toBeTruthy();
    expect(init.headers['X-Title']).toBeTruthy();
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe('anthropic/claude-opus-5');
  });

  it('throws AdapterError with the upstream status on a non-ok response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await expect(adapter.handleCompletion(baseReq, res)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('pipes a non-streaming JSON response straight through', async () => {
    const upstreamJson = { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => upstreamJson });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const mock = createMockRes();

    await adapter.handleCompletion({ ...baseReq, stream: false }, mock.res);

    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.chunks.join(''))).toEqual(upstreamJson);
  });
});
