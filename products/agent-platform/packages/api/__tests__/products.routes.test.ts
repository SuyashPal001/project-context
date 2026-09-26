import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lib = {
  listProducts: vi.fn(), getProduct: vi.fn(), createProduct: vi.fn(),
  renameProduct: vi.fn(), deleteProduct: vi.fn(), loadProductImages: vi.fn(),
};
vi.mock('../lib/productRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/productRecords')>()),
  listProducts: (...a: unknown[]) => lib.listProducts(...a),
  getProduct: (...a: unknown[]) => lib.getProduct(...a),
  createProduct: (...a: unknown[]) => lib.createProduct(...a),
  renameProduct: (...a: unknown[]) => lib.renameProduct(...a),
  deleteProduct: (...a: unknown[]) => lib.deleteProduct(...a),
  loadProductImages: (...a: unknown[]) => lib.loadProductImages(...a),
}));
const nameProductMock = vi.fn();
vi.mock('../lib/productNaming', () => ({ nameProduct: (...a: unknown[]) => nameProductMock(...a) }));
vi.mock('../db', () => ({ db: {} }));

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const product = (over: Record<string, unknown> = {}) => ({
  id: P1, name: 'Serum', description: null, price: null, sourceUrl: null, namingStatus: 'done',
  images: [{ fileId: F1, name: 'a.png', type: 'image/png', size: 3 }], createdAt: '2026-09-27T00:00:00.000Z', ...over,
});

async function app(permissions = [
  { resource: 'files', action: 'read' }, { resource: 'files', action: 'create' }, { resource: 'files', action: 'delete' },
], tenantId: string | null = 'tenant-1') {
  const { productsRoutes } = await import('../routes/products');
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('requestContext' as never, { tenant: tenantId ? { id: tenantId } : undefined, permissions } as never);
    c.set('userId' as never, 'user-1' as never);
    await next();
  });
  a.route('/products', productsRoutes);
  return a;
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); });

describe('/products routes', () => {
  it('lists the tenant\'s products with search and paging passed through', async () => {
    lib.listProducts.mockResolvedValue([product()]);
    const res = await (await app()).request('/products?q=serum&limit=500&offset=50');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    expect(lib.listProducts).toHaveBeenCalledWith('tenant-1', { q: 'serum', limit: 100, offset: 50 });
  });

  it('requires a resolved tenant', async () => {
    const res = await (await app(undefined, null)).request('/products');
    expect(res.status).toBe(400);
    expect(lib.listProducts).not.toHaveBeenCalled();
  });

  it('requires files:read to list', async () => {
    const res = await (await app([{ resource: 'files', action: 'create' }])).request('/products');
    expect(res.status).toBe(403);
  });

  it('creates a pending product from the tenant\'s own image files', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([
      [F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }],
      [F2, { fileId: F2, name: 'b.webp', type: 'image/webp', size: 3 }],
    ]));
    lib.createProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));

    const res = await (await app()).request('/products', json({ fileIds: [F1, F2] }));

    expect(res.status).toBe(201);
    expect(lib.createProduct).toHaveBeenCalledWith({
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Untitled product', description: null,
      price: null, sourceUrl: null, imageFileIds: [F1, F2], namingStatus: 'pending',
    });
  });

  it('rejects files that are missing, from another tenant, or not images', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.pdf', type: 'application/pdf', size: 3 }]]));
    const res = await (await app()).request('/products', json({ fileIds: [F1, F2] }));
    expect(res.status).toBe(400);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it('rejects more than 6 images', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `1111111${i}-1111-4111-8111-111111111111`);
    const res = await (await app()).request('/products', json({ fileIds: ids }));
    expect(res.status).toBe(400);
  });

  it('describes a product and returns the named record', async () => {
    nameProductMock.mockResolvedValue(product({ name: 'Niacinamide serum' }));
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Niacinamide serum');
    expect(nameProductMock).toHaveBeenCalledWith('tenant-1', P1);
  });

  it('404s describe for a product the tenant does not own', async () => {
    nameProductMock.mockResolvedValue(null);
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('renames with a trimmed name', async () => {
    lib.renameProduct.mockResolvedValue(product({ name: 'My serum' }));
    const res = await (await app()).request(`/products/${P1}`, { ...json({ name: '  My serum  ' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(lib.renameProduct).toHaveBeenCalledWith('tenant-1', P1, 'My serum');
  });

  it('rejects an empty or over-long rename', async () => {
    const a = await app();
    expect((await a.request(`/products/${P1}`, { ...json({ name: '   ' }), method: 'PATCH' })).status).toBe(400);
    expect((await a.request(`/products/${P1}`, { ...json({ name: 'x'.repeat(121) }), method: 'PATCH' })).status).toBe(400);
    expect(lib.renameProduct).not.toHaveBeenCalled();
  });

  it('deletes, and 404s an unknown product', async () => {
    lib.deleteProduct.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const a = await app();
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('requires files:delete to delete', async () => {
    const res = await (await app([{ resource: 'files', action: 'read' }])).request(`/products/${P1}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('404s a malformed product id without touching the db', async () => {
    const res = await (await app()).request('/products/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(lib.deleteProduct).not.toHaveBeenCalled();
  });
});
