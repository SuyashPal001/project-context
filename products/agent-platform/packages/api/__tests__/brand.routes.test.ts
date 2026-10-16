import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lib = { getBrand: vi.fn(), patchBrand: vi.fn() };
vi.mock('../lib/brandRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/brandRecords')>()),
  getBrand: (...a: unknown[]) => lib.getBrand(...a),
  patchBrand: (...a: unknown[]) => lib.patchBrand(...a),
}));
const runBrandImport = vi.fn();
vi.mock('../lib/brandImport', () => ({ runBrandImport: (...a: unknown[]) => runBrandImport(...a) }));
const fileOwned = vi.fn();
vi.mock('../lib/brandFiles', () => ({ filesBelongToTenant: (...a: unknown[]) => fileOwned(...a) }));
vi.mock('../db', () => ({ db: {} }));

const F1 = '11111111-1111-4111-8111-111111111111';
const record = { name: 'Mamaearth', importStatus: 'done' };

async function app(permissions = [{ resource: 'files', action: 'read' }, { resource: 'files', action: 'create' }]) {
  const { brandRoutes } = await import('../routes/brand');
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('requestContext' as never, { tenant: { id: 'tenant-1' }, permissions } as never);
    c.set('userId' as never, 'user-1' as never);
    await next();
  });
  a.route('/brand', brandRoutes);
  return a;
}
const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); lib.getBrand.mockResolvedValue(record); fileOwned.mockResolvedValue(true); });

describe('/brand routes', () => {
  it('GET returns null data when there is no brand', async () => {
    lib.getBrand.mockResolvedValue(null);
    const res = await (await app()).request('/brand');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('PATCH validates and saves for this tenant only', async () => {
    const res = await (await app()).request('/brand', send('PATCH', { name: 'New', toneWords: ['warm'] }));
    expect(res.status).toBe(200);
    expect(lib.patchBrand).toHaveBeenCalledWith('tenant-1', 'user-1', { name: 'New', toneWords: ['warm'] });
  });

  it('PATCH rejects a logo file from another workspace', async () => {
    fileOwned.mockResolvedValue(false);
    const res = await (await app()).request('/brand', send('PATCH', { logoFileId: F1 }));
    expect(res.status).toBe(400);
    expect(lib.patchBrand).not.toHaveBeenCalled();
  });

  it('PATCH needs create permission', async () => {
    const res = await (await app([{ resource: 'files', action: 'read' }])).request('/brand', send('PATCH', { name: 'X' }));
    expect(res.status).toBe(403);
  });

  it('POST /import starts an Instagram import and returns 202', async () => {
    const res = await (await app()).request('/brand/import', send('POST', { value: '@mamaearth.in' }));
    expect(res.status).toBe(202);
    expect(runBrandImport).toHaveBeenCalledWith('tenant-1', 'user-1', { type: 'instagram', handle: 'mamaearth.in' });
  });

  it('POST /import rejects input that is neither a site nor a handle', async () => {
    const res = await (await app()).request('/brand/import', send('POST', { value: 'hello world' }));
    expect(res.status).toBe(400);
    expect(runBrandImport).not.toHaveBeenCalled();
  });
});
