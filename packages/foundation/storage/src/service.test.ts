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

describe('StorageService.putFileForTenant', () => {
  beforeEach(() => {
    vi.resetModules();
    selectMock.mockReset();
    getSignedUrlMock.mockReset();
  });

  it('puts the object before inserting the files row, and returns the new fileId', async () => {
    const insertValuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'file-123' }]),
    });
    const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });
    const selectChain = { from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }; // no tenant-specific provider row → falls back to SSM/platform bucket
    selectMock.mockReturnValue(selectChain);
    vi.doMock('@serverless-saas/database', () => ({ db: { select: selectMock, insert: insertMock } }));
    // service.ts imports `files, storageProviders` from this distinct specifier — both
    // are read as plain objects by drizzle's query builder, never invoked directly by
    // this test, so empty stand-ins are enough to satisfy the mock.
    vi.doMock('@serverless-saas/database/schema', () => ({ files: {}, storageProviders: {} }));
    process.env.DOCUMENTS_BUCKET = 'test-bucket';

    const calls: string[] = [];
    const sendMock = vi.fn().mockImplementation((command) => {
      calls.push(command.constructor.name);
      return Promise.resolve({});
    });
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class { send = sendMock },
      GetObjectCommand: class GetObjectCommand { constructor(public input: unknown) {} },
      PutObjectCommand: class PutObjectCommand { constructor(public input: unknown) {} },
      DeleteObjectCommand: class DeleteObjectCommand { constructor(public input: unknown) {} },
    }));

    const { StorageService } = await import('./service');
    const service = new StorageService();

    const result = await service.putFileForTenant('tenant-1', 'user-1', 'imported-products/a.jpg', Buffer.from('bytes'), 'image/jpeg');

    expect(result).toEqual({ fileId: 'file-123', key: 'imported-products/a.jpg' });
    // The S3 put must happen before the DB insert — asserting call order, not just
    // that both happened, is what actually proves I4's ordering fix.
    expect(sendMock.mock.invocationCallOrder[0]).toBeLessThan(insertValuesMock.mock.invocationCallOrder[0]);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      key: 'imported-products/a.jpg',
      mimeType: 'image/jpeg',
      status: 'uploaded',
      uploadedBy: 'user-1',
      size: 5, // Buffer.from('bytes').length
    }));
    const putCommand = sendMock.mock.calls[0][0];
    expect(putCommand.input).toEqual(expect.objectContaining({
      Bucket: 'test-bucket',
      Key: 'tenants/tenant-1/imported-products/a.jpg',
      ContentType: 'image/jpeg',
      Body: Buffer.from('bytes'),
    }));
  });

  it('does not insert a files row when the S3 put fails', async () => {
    const insertMock = vi.fn();
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
    vi.doMock('@serverless-saas/database', () => ({ db: { select: selectMock, insert: insertMock } }));
    vi.doMock('@serverless-saas/database/schema', () => ({ files: {}, storageProviders: {} }));
    process.env.DOCUMENTS_BUCKET = 'test-bucket';

    const sendMock = vi.fn().mockRejectedValue(new Error('S3 down'));
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class { send = sendMock },
      GetObjectCommand: class {},
      PutObjectCommand: class {},
      DeleteObjectCommand: class {},
    }));

    const { StorageService } = await import('./service');
    const service = new StorageService();

    await expect(service.putFileForTenant('tenant-1', 'user-1', 'imported-products/a.jpg', Buffer.from('bytes'), 'image/jpeg'))
      .rejects.toThrow('S3 down');
    expect(insertMock).not.toHaveBeenCalled();
  });
});
