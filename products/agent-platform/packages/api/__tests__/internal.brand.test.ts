import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const rec = { applyImportResult: vi.fn(), markImportFailed: vi.fn(), getBrandRow: vi.fn() };
vi.mock('../lib/brandRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/brandRecords')>()),
  applyImportResult: (...a: unknown[]) => rec.applyImportResult(...a),
  markImportFailed: (...a: unknown[]) => rec.markImportFailed(...a),
  getBrandRow: (...a: unknown[]) => rec.getBrandRow(...a),
}));
const importOneImage = vi.fn();
vi.mock('../lib/safeFetch', () => ({ importOneImage: (...a: unknown[]) => importOneImage(...a) }));
vi.mock('../db', () => ({ db: {} }));

const T = '11111111-1111-4111-8111-111111111111';
async function app() {
  process.env.INTERNAL_SERVICE_KEY = 'k';
  const { internalBrandRoute } = await import('../routes/internal/brand');
  const a = new Hono();
  a.route('/internal/brand', internalBrandRoute);
  return a;
}
const post = (body: unknown, key = 'k') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-key': key }, body: JSON.stringify(body) });
const fields = { name: 'Mamaearth', toneWords: ['warm'], region: 'IN', emojiPolicy: 'minimal' };

beforeEach(() => {
  vi.clearAllMocks();
  rec.getBrandRow.mockResolvedValue({ importStatus: 'importing', createdBy: 'user-1' });
  rec.applyImportResult.mockResolvedValue('applied');
});

describe('POST /internal/brand/import-result', () => {
  it('refuses a call without the service key', async () => {
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: false, error: 'x' }, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('saves the logo to Drive under brand/ and applies the fields', async () => {
    importOneImage.mockResolvedValueOnce({ fileId: 'logo-file' });
    const res = await (await app()).request('/internal/brand/import-result',
      post({ tenantId: T, ok: true, fields, sourceText: 'Mamaearth', logoUrl: 'https://cdn.example/logo.png' }));
    expect(res.status).toBe(200);
    expect(importOneImage).toHaveBeenCalledWith('https://cdn.example/logo.png', T, 'user-1', 'brand/');
    expect(rec.applyImportResult).toHaveBeenCalledWith(T, expect.objectContaining({ name: 'Mamaearth' }), 'Mamaearth', { logoFileId: 'logo-file', faviconFileId: undefined });
  });

  it('still applies the text fields when the logo cannot be saved', async () => {
    importOneImage.mockRejectedValueOnce(new Error('403'));
    await (await app()).request('/internal/brand/import-result',
      post({ tenantId: T, ok: true, fields, sourceText: '', logoUrl: 'https://cdn.example/logo.png' }));
    expect(rec.applyImportResult).toHaveBeenCalledWith(T, expect.anything(), '', { logoFileId: undefined, faviconFileId: undefined });
  });

  it('ignores a result when no import is running (a newer edit or import won)', async () => {
    rec.getBrandRow.mockResolvedValue({ importStatus: 'done', createdBy: 'user-1' });
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: true, fields, sourceText: '' }));
    expect(await res.json()).toEqual({ result: 'ignored' });
    expect(importOneImage).not.toHaveBeenCalled();
    expect(rec.applyImportResult).not.toHaveBeenCalled();
  });

  it('marks the import failed on an error report', async () => {
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: false, error: 'gateway 500' }));
    expect(await res.json()).toEqual({ result: 'failed' });
    expect(rec.markImportFailed).toHaveBeenCalledWith(T, 'gateway 500');
  });

  it('ignores an error report when no import is running', async () => {
    rec.getBrandRow.mockResolvedValue({ importStatus: 'done', createdBy: 'user-1' });
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: false, error: 'late error' }));
    expect(await res.json()).toEqual({ result: 'ignored' });
    expect(rec.markImportFailed).not.toHaveBeenCalled();
  });

  it('ignores a result with ok:true when the row does not exist', async () => {
    rec.getBrandRow.mockResolvedValue(null);
    const res = await (await app()).request('/internal/brand/import-result', post({ tenantId: T, ok: true, fields, sourceText: '' }));
    expect(await res.json()).toEqual({ result: 'ignored' });
    expect(importOneImage).not.toHaveBeenCalled();
    expect(rec.applyImportResult).not.toHaveBeenCalled();
  });
});
