import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

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

const nameProductMock = vi.fn();
vi.mock('../lib/productNaming', () => ({ nameProduct: (...a: unknown[]) => nameProductMock(...a) }));
const createProductMock = vi.fn();
vi.mock('../lib/productRecords', () => ({
  PRODUCT_NAME_PLACEHOLDER: 'Untitled product',
  createProduct: (...a: unknown[]) => createProductMock(...a),
}));
vi.mock('../db', () => ({ db: {} }));

function htmlResponse(html: string, url = 'https://shop.example.com/p/1', status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    body: { getReader: () => textReader(html) },
  } as unknown as Response;
}

function imageResponse(bytes: Uint8Array, contentType = 'image/jpeg') {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', contentType]]),
    body: { getReader: () => byteReader(bytes) },
  } as unknown as Response;
}

function textReader(text: string) {
  const bytes = new TextEncoder().encode(text);
  return byteReader(bytes);
}

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

// Both response helpers use a `.headers` value with a real `.get(...)` method
// where the route reads it — Map has `.get`, matching the Headers API surface
// this route actually calls.
function withGet(map: Map<string, string>) {
  return { get: (key: string) => map.get(key.toLowerCase()) ?? null };
}

function buildApp() {
  // Re-require after mocks are set so the route module picks up the mocked imports.
  return import('../routes/products.import').then(({ productsImportRoutes }) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext', {
        tenant: { id: 'tenant-1' },
        permissions: [{ resource: 'files', action: 'create' }],
      });
      c.set('userId', 'user-1');
      await next();
    });
    app.route('/products/import', productsImportRoutes);
    return app;
  });
}

describe('POST /products/import', () => {
  beforeEach(() => {
    vi.resetModules();
    putFileForTenantMock.mockReset();
    assertPublicHttpUrlMock.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
    nameProductMock.mockReset().mockResolvedValue(null);
    createProductMock.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'p1', name: input.name, description: input.description, price: input.price, sourceUrl: input.sourceUrl,
      namingStatus: input.namingStatus, images: [], createdAt: '2026-09-27T00:00:00.000Z',
    }));
  });

  it('returns 422 and saves nothing when the page has no importable images', async () => {
    fetchMock.mockResolvedValueOnce({
      ...htmlResponse('<html><head><meta property="og:title" content="Mug"></head></html>'),
      headers: withGet(new Map([['content-type', 'text/html']])),
    });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe('No product images found on that page');
    expect(createProductMock).not.toHaveBeenCalled();
    expect(assertPublicHttpUrlMock).toHaveBeenCalledWith('https://shop.example.com/p/1');
  });

  it('saves a named product with every imported image in page order', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ...htmlResponse('<html><head><meta property="og:title" content="Mug"><meta property="og:description" content="Stoneware"><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>'),
        headers: withGet(new Map([['content-type', 'text/html']])),
      })
      .mockResolvedValueOnce({ ...imageResponse(new Uint8Array([1, 2, 3])), headers: withGet(new Map([['content-type', 'image/jpeg']])) });
    putFileForTenantMock.mockResolvedValue({ fileId: 'file-a' });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(200);
    expect(createProductMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Mug', description: 'Stoneware', price: null,
      sourceUrl: 'https://shop.example.com/p/1', imageFileIds: ['file-a'], namingStatus: 'done',
    });
    expect((await res.json()).data.name).toBe('Mug');
  });

  it('saves a pending product with the placeholder name when the page has images but no title', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ...htmlResponse('<html><head><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>'),
        headers: withGet(new Map([['content-type', 'text/html']])),
      })
      .mockResolvedValueOnce({ ...imageResponse(new Uint8Array([1])), headers: withGet(new Map([['content-type', 'image/jpeg']])) });
    putFileForTenantMock.mockResolvedValue({ fileId: 'file-a' });

    const app = await buildApp();
    await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(createProductMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Untitled product', namingStatus: 'pending' }));
    // A title-less import is named in the same request, not left for the browser.
    expect(nameProductMock).toHaveBeenCalledWith('tenant-1', 'p1');
  });

  it('does not run AI naming when the page already had a title', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ...htmlResponse('<html><head><meta property="og:title" content="Mug"><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>'),
        headers: withGet(new Map([['content-type', 'text/html']])),
      })
      .mockResolvedValueOnce({ ...imageResponse(new Uint8Array([1])), headers: withGet(new Map([['content-type', 'image/jpeg']])) });
    putFileForTenantMock.mockResolvedValue({ fileId: 'file-a' });

    const app = await buildApp();
    await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(nameProductMock).not.toHaveBeenCalled();
  });

  it('rejects a non-https URL with 400 before any fetch', async () => {
    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://shop.example.com/p/1' }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 422 with a generic message when the SSRF guard blocks the URL, never the guard\'s internal detail', async () => {
    assertPublicHttpUrlMock.mockRejectedValueOnce(new SsrfBlockedError('Host resolves to a non-public address: 169.254.169.254'));
    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://internal.example.com' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).not.toContain('169.254.169.254');
  });

  it('returns 422 for a non-HTML response without attempting to parse it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://shop.example.com/file.pdf',
      headers: withGet(new Map([['content-type', 'application/pdf']])),
      body: { getReader: () => byteReader(new Uint8Array([1, 2, 3])) },
    });
    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/file.pdf' }),
    });
    expect(res.status).toBe(422);
  });

  it('requires the files:create permission', async () => {
    const { productsImportRoutes } = await import('../routes/products.import');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] });
      c.set('userId', 'user-1');
      await next();
    });
    app.route('/products/import', productsImportRoutes);

    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a resolved tenant', async () => {
    const { productsImportRoutes } = await import('../routes/products.import');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext', { tenant: null, permissions: [{ resource: 'files', action: 'create' }] });
      c.set('userId', 'user-1');
      await next();
    });
    app.route('/products/import', productsImportRoutes);

    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });
    expect(res.status).toBe(400);
  });

  it('stores an accepted image under the imported-products/ prefix via putFileForTenant, not getUploadUrl', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200, url: 'https://shop.example.com/p/1',
        headers: withGet(new Map([['content-type', 'text/html']])),
        body: { getReader: () => textReader('<html><head><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>') },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: withGet(new Map([['content-type', 'image/jpeg']])),
        body: { getReader: () => byteReader(new Uint8Array([1, 2, 3])) },
      });
    putFileForTenantMock.mockResolvedValueOnce({ fileId: 'file-9', key: 'imported-products/x.jpg' });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(200);
    expect(createProductMock).toHaveBeenCalledWith(expect.objectContaining({ imageFileIds: ['file-9'] }));
    const [, , userKey] = putFileForTenantMock.mock.calls[0];
    expect(userKey).toMatch(/^imported-products\//);
  });

  it('derives a safe, bounded filename for the key and returned name', async () => {
    const longName = 'a'.repeat(400);
    const imageUrl = `https://cdn.example.com/x/${longName}%20caf%C3%A9%20%E2%9C%93!!.jpg`;
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200, url: 'https://shop.example.com/p/1',
        headers: withGet(new Map([['content-type', 'text/html']])),
        body: { getReader: () => textReader(`<html><head><meta property="og:image" content="${imageUrl}"></head></html>`) },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: withGet(new Map([['content-type', 'image/jpeg']])),
        body: { getReader: () => byteReader(new Uint8Array([1, 2, 3])) },
      });
    putFileForTenantMock.mockResolvedValueOnce({ fileId: 'file-9', key: 'k' });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(200);
    const [, , key] = putFileForTenantMock.mock.calls[0];
    expect(key).toMatch(/^imported-products\//);
    expect(key.length).toBeLessThan(200);
    // uuid-<safe filename> tail: pull the filename back out of the stored key
    // to check the same safety bound the response used to expose directly.
    const name = key.replace(/^imported-products\/[0-9a-f-]+-/, '');
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(key.endsWith(`-${name}`)).toBe(true);
  });

  it('keeps images that succeed when another image in the same import fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200, url: 'https://shop.example.com/p/1',
        headers: withGet(new Map([['content-type', 'text/html']])),
        body: { getReader: () => textReader(`<html><head>
          <meta property="og:image" content="https://cdn.example.com/good.jpg">
          <meta property="og:image" content="https://cdn.example.com/bad.jpg">
        </head></html>`) },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: withGet(new Map([['content-type', 'image/jpeg']])),
        body: { getReader: () => byteReader(new Uint8Array([1])) },
      })
      .mockResolvedValueOnce({
        ok: false, status: 500,
        headers: withGet(new Map([['content-type', 'image/jpeg']])),
        body: { getReader: () => byteReader(new Uint8Array([])) },
      });
    putFileForTenantMock.mockResolvedValueOnce({ fileId: 'file-good', key: 'imported-products/good.jpg' });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(200);
    expect(createProductMock).toHaveBeenCalledWith(expect.objectContaining({ imageFileIds: ['file-good'] }));
  });

  it('rejects a redirect to a private address on the hop and never fetches it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 302,
      headers: withGet(new Map([['location', 'https://internal.example.com/x']])),
    });
    assertPublicHttpUrlMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SsrfBlockedError('Host resolves to a non-public address: 10.0.0.5'));
    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.5');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an https-to-http redirect and never fetches it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 302,
      headers: withGet(new Map([['location', 'http://shop.example.com/p/2']])),
    });
    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });
    expect(res.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A body whose read() never resolves on its own; it only rejects when the
  // signal passed to fetch() aborts, like a real fetch body stream.
  function stalledBody(init: { signal?: AbortSignal }) {
    return {
      getReader: () => ({
        read: () => new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
        cancel: async () => {},
      }),
    };
  }

  it('returns 422 when the page body stalls past the timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(async (_url: string, init: { signal?: AbortSignal }) => ({
        ok: true, status: 200, url: 'https://shop.example.com/p/1',
        headers: withGet(new Map([['content-type', 'text/html']])),
        body: stalledBody(init),
      }));
      const app = await buildApp();
      const pending = app.request('/products/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(422);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the page fields and other images when one image body stalls', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce({
          ok: true, status: 200, url: 'https://shop.example.com/p/1',
          headers: withGet(new Map([['content-type', 'text/html']])),
          body: { getReader: () => textReader(`<html><head><title>Mug</title>
            <meta property="og:image" content="https://cdn.example.com/good.jpg">
            <meta property="og:image" content="https://cdn.example.com/stall.jpg">
          </head></html>`) },
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          headers: withGet(new Map([['content-type', 'image/jpeg']])),
          body: { getReader: () => byteReader(new Uint8Array([1])) },
        })
        .mockImplementationOnce(async (_url: string, init: { signal?: AbortSignal }) => ({
          ok: true, status: 200,
          headers: withGet(new Map([['content-type', 'image/jpeg']])),
          body: stalledBody(init),
        }));
      putFileForTenantMock.mockResolvedValueOnce({ fileId: 'file-good', key: 'imported-products/good.jpg' });
      const app = await buildApp();
      const pending = app.request('/products/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(createProductMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mug', imageFileIds: ['file-good'] }));
    } finally {
      vi.useRealTimers();
    }
  });
});
