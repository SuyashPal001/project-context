import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
vi.mock('@serverless-saas/database', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));
// service.ts also imports `files, storageProviders` from the distinct
// '@serverless-saas/database/schema' specifier (not just '@serverless-saas/database')
// — if this test errors on module resolution rather than on an assertion,
// check whether that specifier needs its own vi.mock too (it's pure table
// definitions with no runtime behavior, so it's expected to resolve fine
// unmocked, but this is the first place to look if not).
vi.mock('@serverless-saas/database/schema', () => ({}));

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...a: unknown[]) => getSignedUrlMock(...a) }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: class { constructor(public input: unknown) {} },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));

describe('StorageService.getLibraryAssetDownloadUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    selectMock.mockReset();
    getSignedUrlMock.mockReset();
    process.env.DOCUMENTS_BUCKET = 'test-platform-bucket';
  });

  it('never queries the tenant storageProviders table for a library asset', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/creative-library/avatars/tech-presenter.jpg');
    const { StorageService } = await import('./service');
    const service = new StorageService();

    const url = await service.getLibraryAssetDownloadUrl('creative-library/avatars/tech-presenter.jpg');

    expect(url).toBe('https://signed.example/creative-library/avatars/tech-presenter.jpg');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('signs against DOCUMENTS_BUCKET with the exact storage key', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/x');
    const { StorageService } = await import('./service');
    const service = new StorageService();

    await service.getLibraryAssetDownloadUrl('creative-library/avatars/tech-presenter.jpg');

    const [, command] = getSignedUrlMock.mock.calls[0];
    expect((command as { input: { Bucket: string; Key: string } }).input).toEqual({
      Bucket: 'test-platform-bucket',
      Key: 'creative-library/avatars/tech-presenter.jpg',
    });
  });
});
