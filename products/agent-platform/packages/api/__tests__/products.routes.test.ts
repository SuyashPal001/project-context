import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lib = {
  listProducts: vi.fn(), getProduct: vi.fn(), createProduct: vi.fn(),
  updateProduct: vi.fn(), deleteProduct: vi.fn(), loadProductImages: vi.fn(),
  listProductImageFileIds: vi.fn(),
};
vi.mock('../lib/productRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/productRecords')>()),
  listProducts: (...a: unknown[]) => lib.listProducts(...a),
  getProduct: (...a: unknown[]) => lib.getProduct(...a),
  createProduct: (...a: unknown[]) => lib.createProduct(...a),
  updateProduct: (...a: unknown[]) => lib.updateProduct(...a),
  deleteProduct: (...a: unknown[]) => lib.deleteProduct(...a),
  loadProductImages: (...a: unknown[]) => lib.loadProductImages(...a),
  listProductImageFileIds: (...a: unknown[]) => lib.listProductImageFileIds(...a),
}));
const nameProductMock = vi.fn();
vi.mock('../lib/productNaming', () => ({ nameProduct: (...a: unknown[]) => nameProductMock(...a) }));
const deleteUnusedProductFilesMock = vi.fn();
vi.mock('../lib/productFileCleanup', () => ({ deleteUnusedProductFiles: (...a: unknown[]) => deleteUnusedProductFilesMock(...a) }));
vi.mock('../db', () => ({ db: {} }));

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const product = (over: Record<string, unknown> = {}) => ({
  id: P1, name: 'Serum', category: null, description: null, price: null, sourceUrl: null, usps: [], namingStatus: 'done',
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
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Untitled product', category: null, description: null,
      price: null, sourceUrl: null, usps: [], imageFileIds: [F1, F2], namingStatus: 'pending',
    });
  });

  it('creates a product manually from a name, with no photos and no AI naming', async () => {
    lib.createProduct.mockResolvedValue(product({ name: 'Campus Shoes', category: 'Apparel', usps: ['Lightweight'], images: [] }));

    const res = await (await app()).request('/products', json({
      name: 'Campus Shoes', category: 'Apparel', description: 'Everyday sneaker', usps: ['Lightweight'],
    }));

    expect(res.status).toBe(201);
    expect(lib.createProduct).toHaveBeenCalledWith({
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Campus Shoes', category: 'Apparel',
      description: 'Everyday sneaker', price: null, sourceUrl: null, usps: ['Lightweight'],
      imageFileIds: [], namingStatus: 'done',
    });
    expect(nameProductMock).not.toHaveBeenCalled();
  });

  it('accepts photos sent as imageFileIds on create (the setup modal\'s field name), not just fileIds', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }]]));
    lib.createProduct.mockResolvedValue(product({ name: 'Mug', images: [{ fileId: F1, name: 'a.png', type: 'image/png', size: 3 }] }));

    const res = await (await app()).request('/products', json({ name: 'Mug', imageFileIds: [F1] }));

    expect(res.status).toBe(201);
    expect(lib.createProduct).toHaveBeenCalledWith(expect.objectContaining({ imageFileIds: [F1] }));
  });

  it('normalizes an empty-string description to null on create', async () => {
    lib.createProduct.mockResolvedValue(product({ name: 'Mug' }));
    await (await app()).request('/products', json({ name: 'Mug', description: '' }));
    expect(lib.createProduct).toHaveBeenCalledWith(expect.objectContaining({ description: null }));
  });

  it('normalizes an empty-string description to null on update', async () => {
    lib.updateProduct.mockResolvedValue(product());
    await (await app()).request(`/products/${P1}`, { ...json({ description: '' }), method: 'PATCH' });
    expect(lib.updateProduct).toHaveBeenCalledWith('tenant-1', P1, { description: null });
  });

  it('rejects a manual create with neither a name nor any photos', async () => {
    const res = await (await app()).request('/products', json({}));
    expect(res.status).toBe(400);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it('rejects an unknown category', async () => {
    const res = await (await app()).request('/products', json({ name: 'Mug', category: 'Automotive' }));
    expect(res.status).toBe(400);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it('rejects more than 3 usps', async () => {
    const res = await (await app()).request('/products', json({ name: 'Mug', usps: ['a', 'b', 'c', 'd'] }));
    expect(res.status).toBe(400);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  // Naming used to depend on the browser sending a second /describe request;
  // when it never came (tab switched, page left, network drop) the product
  // stayed "Untitled product" / pending forever. Seen live 2026-09-27.
  it('names the product in the same request and returns it already named', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }]]));
    lib.createProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));
    nameProductMock.mockResolvedValue(product({ namingStatus: 'done', name: 'Campus Shoes' }));

    const res = await (await app()).request('/products', json({ fileIds: [F1] }));

    expect(res.status).toBe(201);
    expect(nameProductMock).toHaveBeenCalledWith('tenant-1', P1);
    expect((await res.json()).data).toEqual(expect.objectContaining({ name: 'Campus Shoes', namingStatus: 'done' }));
  });

  it('still returns the created product when naming throws', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }]]));
    lib.createProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));
    nameProductMock.mockRejectedValue(new Error('db blip'));

    const res = await (await app()).request('/products', json({ fileIds: [F1] }));

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual(expect.objectContaining({ name: 'Untitled product' }));
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
    lib.getProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));
    nameProductMock.mockResolvedValue(product({ name: 'Niacinamide serum' }));
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Niacinamide serum');
    expect(nameProductMock).toHaveBeenCalledWith('tenant-1', P1);
  });

  it('404s describe for a product the tenant does not own', async () => {
    lib.getProduct.mockResolvedValue(null);
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(nameProductMock).not.toHaveBeenCalled();
  });

  // /describe is bounded like create: the web proxy aborts at 15 s, and a 504
  // left the brief chip on the placeholder even though naming later landed.
  it('describe returns the product still pending when naming outlasts the budget', async () => {
    vi.useFakeTimers();
    try {
      lib.getProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));
      nameProductMock.mockReturnValue(new Promise(() => {}));
      const pendingRes = (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pendingRes;
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual(expect.objectContaining({ namingStatus: 'pending' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renames with a trimmed name', async () => {
    lib.updateProduct.mockResolvedValue(product({ name: 'My serum' }));
    const res = await (await app()).request(`/products/${P1}`, { ...json({ name: '  My serum  ' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(lib.updateProduct).toHaveBeenCalledWith('tenant-1', P1, { name: 'My serum' });
  });

  it('rejects an empty or over-long rename', async () => {
    const a = await app();
    expect((await a.request(`/products/${P1}`, { ...json({ name: '   ' }), method: 'PATCH' })).status).toBe(400);
    expect((await a.request(`/products/${P1}`, { ...json({ name: 'x'.repeat(121) }), method: 'PATCH' })).status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('updates category, description and usps together', async () => {
    lib.updateProduct.mockResolvedValue(product({ category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery', 'IPX4'] }));
    const res = await (await app()).request(`/products/${P1}`, {
      ...json({ category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery', 'IPX4'] }),
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    expect(lib.updateProduct).toHaveBeenCalledWith('tenant-1', P1, {
      category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery', 'IPX4'],
    });
  });

  it('clears category and description by sending null', async () => {
    lib.updateProduct.mockResolvedValue(product());
    const res = await (await app()).request(`/products/${P1}`, { ...json({ category: null, description: null }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(lib.updateProduct).toHaveBeenCalledWith('tenant-1', P1, { category: null, description: null });
  });

  it('updates the image set on PATCH after validating ownership and type', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([
      [F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }],
      [F2, { fileId: F2, name: 'b.webp', type: 'image/webp', size: 3 }],
    ]));
    lib.updateProduct.mockResolvedValue(product({ images: [{ fileId: F1, name: 'a.png', type: 'image/png', size: 3 }] }));
    const res = await (await app()).request(`/products/${P1}`, { ...json({ imageFileIds: [F1, F2] }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(lib.updateProduct).toHaveBeenCalledWith('tenant-1', P1, { imageFileIds: [F1, F2] });
  });

  it('rejects a PATCH image set containing a file that is missing, another tenant\'s, or not an image', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.pdf', type: 'application/pdf', size: 3 }]]));
    const res = await (await app()).request(`/products/${P1}`, { ...json({ imageFileIds: [F1, F2] }), method: 'PATCH' });
    expect(res.status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('rejects more than 6 images on PATCH', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `1111111${i}-1111-4111-8111-111111111111`);
    const res = await (await app()).request(`/products/${P1}`, { ...json({ imageFileIds: ids }), method: 'PATCH' });
    expect(res.status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('rejects an unknown category on update', async () => {
    const res = await (await app()).request(`/products/${P1}`, { ...json({ category: 'Automotive' }), method: 'PATCH' });
    expect(res.status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('rejects more than 3 usps on update', async () => {
    const res = await (await app()).request(`/products/${P1}`, { ...json({ usps: ['a', 'b', 'c', 'd'] }), method: 'PATCH' });
    expect(res.status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('rejects an empty PATCH body', async () => {
    const res = await (await app()).request(`/products/${P1}`, { ...json({}), method: 'PATCH' });
    expect(res.status).toBe(400);
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it('404s a PATCH for a product the tenant does not own', async () => {
    lib.updateProduct.mockResolvedValue(null);
    const res = await (await app()).request(`/products/${P1}`, { ...json({ name: 'New name' }), method: 'PATCH' });
    expect(res.status).toBe(404);
  });

  it('deletes, and 404s an unknown product', async () => {
    lib.deleteProduct.mockResolvedValueOnce([F1]).mockResolvedValueOnce(null);
    const a = await app();
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('deleting a product deletes its photos too', async () => {
    lib.deleteProduct.mockResolvedValueOnce([F1, F2]);
    const res = await (await app()).request(`/products/${P1}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteUnusedProductFilesMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', fileIds: [F1, F2], actorId: 'user-1' }));
  });

  it('still deletes the product when cleaning up its photos fails', async () => {
    lib.deleteProduct.mockResolvedValueOnce([F1]);
    deleteUnusedProductFilesMock.mockRejectedValueOnce(new Error('queue down'));
    const res = await (await app()).request(`/products/${P1}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('does not touch photos when the product was not found', async () => {
    lib.deleteProduct.mockResolvedValueOnce(null);
    await (await app()).request(`/products/${P1}`, { method: 'DELETE' });
    expect(deleteUnusedProductFilesMock).not.toHaveBeenCalled();
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

  it('lists the tenant\'s product image file ids', async () => {
    lib.listProductImageFileIds.mockResolvedValue([F1, F2]);
    const res = await (await app()).request('/products/image-file-ids');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([F1, F2]);
    expect(lib.listProductImageFileIds).toHaveBeenCalledWith('tenant-1');
  });

  it('requires files:read for image file ids', async () => {
    const res = await (await app([{ resource: 'files', action: 'create' }])).request('/products/image-file-ids');
    expect(res.status).toBe(403);
  });
});
