import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteFileMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { deleteFile: (...a: unknown[]) => deleteFileMock(...a) } }));
const publishToQueueMock = vi.fn();
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: (...a: unknown[]) => publishToQueueMock(...a) }));
const listProductImageFileIdsMock = vi.fn();
vi.mock('../lib/productRecords', () => ({ listProductImageFileIds: (...a: unknown[]) => listProductImageFileIdsMock(...a) }));
const auditValues = vi.fn();
vi.mock('../db', () => ({ db: { insert: vi.fn(() => ({ values: (v: unknown) => { auditValues(v); return Promise.resolve(); } })) } }));

import { deleteUnusedProductFiles } from '../lib/productFileCleanup';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/q';
  listProductImageFileIdsMock.mockResolvedValue([]);
  deleteFileMock.mockImplementation(async (_t: string, id: string) => `key/${id}`);
});

describe('deleteUnusedProductFiles', () => {
  it('soft-deletes each photo, queues its S3 purge and writes an audit entry, like Drive does', async () => {
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1', 'f2'], actorId: 'u1', traceId: 'tr' });

    expect(deleteFileMock.mock.calls).toEqual([['t1', 'f1'], ['t1', 'f2']]);
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/f1' } });
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/f2' } });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', actorId: 'u1', action: 'file_deleted', resource: 'file', resourceId: 'f1', metadata: { reason: 'product_deleted' },
    }));
  });

  it('keeps a photo another product still uses', async () => {
    listProductImageFileIdsMock.mockResolvedValue(['f2']);
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1', 'f2'], actorId: 'u1', traceId: '' });
    expect(deleteFileMock.mock.calls).toEqual([['t1', 'f1']]);
  });

  it('does not purge or audit a file that was not deleted (e.g. another tenant\'s id)', async () => {
    deleteFileMock.mockResolvedValue(null);
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1'], actorId: 'u1', traceId: '' });
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });

  it('keeps deleting the other photos when one fails', async () => {
    deleteFileMock.mockRejectedValueOnce(new Error('db blip')).mockImplementation(async (_t: string, id: string) => `key/${id}`);
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1', 'f2'], actorId: 'u1', traceId: '' });
    expect(deleteFileMock.mock.calls).toEqual([['t1', 'f1'], ['t1', 'f2']]);
    expect(publishToQueueMock).toHaveBeenCalledTimes(1);
  });

  it('records a system actor when no user is known', async () => {
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1'], actorId: null, traceId: '' });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'system', actorType: 'system' }));
  });

  it('dedupes ids and does nothing for an empty list', async () => {
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: ['f1', 'f1'], actorId: 'u1', traceId: '' });
    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await deleteUnusedProductFiles({ tenantId: 't1', fileIds: [], actorId: 'u1', traceId: '' });
    expect(listProductImageFileIdsMock).not.toHaveBeenCalled();
  });
});
