import { describe, it, expect, vi, beforeEach } from 'vitest';

const downloadFileMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { downloadFile: (...a: unknown[]) => downloadFileMock(...a) } }));
const getProductMock = vi.fn();
const applyNamingResultMock = vi.fn();
vi.mock('../lib/productRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/productRecords')>()),
  getProduct: (...a: unknown[]) => getProductMock(...a),
  applyNamingResult: (...a: unknown[]) => applyNamingResultMock(...a),
}));
vi.mock('../db', () => ({ db: {} }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { describeProductImage, nameProduct, MAX_NAMING_IMAGE_BYTES } from '../lib/productNaming';

const image = { fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_ORCHESTRATOR_URL = 'http://orch.test';
  process.env.INTERNAL_SERVICE_KEY = 'key-1';
});

describe('describeProductImage', () => {
  it('sends the image to the orchestrator with the service key and returns the trimmed result', async () => {
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: '  Niacinamide serum ', description: ' A dropper bottle. ' }) });

    const result = await describeProductImage('t1', image);

    expect(result).toEqual({ name: 'Niacinamide serum', description: 'A dropper bottle.' });
    expect(downloadFileMock).toHaveBeenCalledWith('t1', 'f1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://orch.test/internal/products/describe');
    expect(init.headers['X-Service-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual({ tenantId: 't1', imageBase64: Buffer.from('abc').toString('base64'), mimeType: 'image/png' });
  });

  it('skips images over the size cap without calling the orchestrator', async () => {
    downloadFileMock.mockResolvedValue(Buffer.alloc(MAX_NAMING_IMAGE_BYTES + 1));
    expect(await describeProductImage('t1', image)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the orchestrator fails or returns no name', async () => {
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    expect(await describeProductImage('t1', image)).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ name: '   ' }) });
    expect(await describeProductImage('t1', image)).toBeNull();
  });

  it('returns null when the orchestrator is not configured', async () => {
    delete process.env.AGENT_ORCHESTRATOR_URL;
    expect(await describeProductImage('t1', image)).toBeNull();
    expect(downloadFileMock).not.toHaveBeenCalled();
  });
});

describe('nameProduct', () => {
  it('names a pending product from its main image and returns the fresh record', async () => {
    getProductMock
      .mockResolvedValueOnce({ id: 'p1', namingStatus: 'pending', images: [image] })
      .mockResolvedValueOnce({ id: 'p1', namingStatus: 'done', name: 'Serum', images: [image] });
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: 'Serum', description: null }) });

    const record = await nameProduct('t1', 'p1');

    expect(applyNamingResultMock).toHaveBeenCalledWith('t1', 'p1', { name: 'Serum', description: null });
    expect(record?.name).toBe('Serum');
  });

  it('does not call the model for a product that is not pending', async () => {
    getProductMock.mockResolvedValue({ id: 'p1', namingStatus: 'done', images: [image] });
    await nameProduct('t1', 'p1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyNamingResultMock).not.toHaveBeenCalled();
  });

  it('marks naming failed when the result is null', async () => {
    getProductMock.mockResolvedValue({ id: 'p1', namingStatus: 'pending', images: [image] });
    downloadFileMock.mockRejectedValue(new Error('File not found: f1'));
    await nameProduct('t1', 'p1');
    expect(applyNamingResultMock).toHaveBeenCalledWith('t1', 'p1', null);
  });

  it('returns null for an unknown product', async () => {
    getProductMock.mockResolvedValue(null);
    expect(await nameProduct('t1', 'nope')).toBeNull();
  });
});
