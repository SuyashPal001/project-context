import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const selectMock = vi.fn();
vi.mock('../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));

const getLibraryAssetDownloadUrlMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { getLibraryAssetDownloadUrl: (...a: unknown[]) => getLibraryAssetDownloadUrlMock(...a) } }));

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  selectMock.mockReturnValue(chain);
  return chain;
}

describe('GET /creative-library-assets/:id/presigned-url', () => {
  beforeEach(() => {
    selectMock.mockReset();
    getLibraryAssetDownloadUrlMock.mockReset();
  });

  it('returns a presignedUrl for an existing row', async () => {
    selectChain([{ storageKey: 'creative-library/avatars/tech-presenter.jpg' }]);
    getLibraryAssetDownloadUrlMock.mockResolvedValue('https://signed.example/x.jpg');
    const { creativeLibraryAssetsRoutes } = await import('../routes/creativeLibraryAssets');
    const app = new Hono().route('/creative-library-assets', creativeLibraryAssetsRoutes);

    const res = await app.request('/creative-library-assets/8b6e9254-cc47-492c-bdc7-557ac6302e01/presigned-url');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ presignedUrl: 'https://signed.example/x.jpg' });
    expect(getLibraryAssetDownloadUrlMock).toHaveBeenCalledWith('creative-library/avatars/tech-presenter.jpg');
  });

  it('returns 404 for an id with no matching row', async () => {
    selectChain([]);
    const { creativeLibraryAssetsRoutes } = await import('../routes/creativeLibraryAssets');
    const app = new Hono().route('/creative-library-assets', creativeLibraryAssetsRoutes);

    const res = await app.request('/creative-library-assets/00000000-0000-0000-0000-000000000000/presigned-url');

    expect(res.status).toBe(404);
    expect(getLibraryAssetDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed (non-uuid) id without querying the db', async () => {
    const { creativeLibraryAssetsRoutes } = await import('../routes/creativeLibraryAssets');
    const app = new Hono().route('/creative-library-assets', creativeLibraryAssetsRoutes);

    const res = await app.request('/creative-library-assets/not-a-uuid/presigned-url');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found', message: 'Creative library asset not found' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(getLibraryAssetDownloadUrlMock).not.toHaveBeenCalled();
  });
});
