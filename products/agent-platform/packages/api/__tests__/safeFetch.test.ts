import { describe, it, expect, vi, beforeEach } from 'vitest';

const putFileForTenantMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { putFileForTenant: (...a: unknown[]) => putFileForTenantMock(...a) } }));

const assertPublicHttpUrlMock = vi.fn();
class SsrfBlockedError extends Error {}
vi.mock('@serverless-saas/agent-worker-handlers/lib/ssrf-guard', () => ({
  assertPublicHttpUrl: (...a: unknown[]) => assertPublicHttpUrlMock(...a),
  SsrfBlockedError,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function byteReader(bytes: Uint8Array) {
  let done = false;
  return {
    read: async () => {
      if (done) return { done: true, value: undefined };
      done = true;
      return { done: false, value: bytes };
    },
    cancel: async () => {},
  };
}

function textReader(text: string) {
  return byteReader(new TextEncoder().encode(text));
}

function withGet(map: Map<string, string>) {
  return { get: (key: string) => map.get(key.toLowerCase()) ?? null };
}

describe('fetchText', () => {
  beforeEach(() => {
    vi.resetModules();
    putFileForTenantMock.mockReset();
    assertPublicHttpUrlMock.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
  });

  it('returns null on a non-ok status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      url: 'https://example.com/page',
      headers: withGet(new Map([['content-type', 'text/html']])),
      body: { getReader: () => textReader('oops') },
    });
    const { fetchText } = await import('../lib/safeFetch');

    const result = await fetchText('https://example.com/page', {
      timeoutMs: 1000,
      maxBytes: 1024,
      accept: (ct) => ct.includes('text/html'),
    });

    expect(result).toBeNull();
  });

  it('returns null when the content type is rejected by accept', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://example.com/page',
      headers: withGet(new Map([['content-type', 'application/pdf']])),
      body: { getReader: () => textReader('not html') },
    });
    const { fetchText } = await import('../lib/safeFetch');

    const result = await fetchText('https://example.com/page', {
      timeoutMs: 1000,
      maxBytes: 1024,
      accept: (ct) => ct.includes('text/html'),
    });

    expect(result).toBeNull();
  });

  it('returns the text and final url on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://example.com/final-page',
      headers: withGet(new Map([['content-type', 'text/html; charset=utf-8']])),
      body: { getReader: () => textReader('<html>hello</html>') },
    });
    const { fetchText } = await import('../lib/safeFetch');

    const result = await fetchText('https://example.com/page', {
      timeoutMs: 1000,
      maxBytes: 1024,
      accept: (ct) => ct.includes('text/html'),
    });

    expect(result).toEqual({ text: '<html>hello</html>', finalUrl: 'https://example.com/final-page' });
  });
});
