import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteFileMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { deleteFile: (...a: unknown[]) => deleteFileMock(...a) } }));
const publishToQueueMock = vi.fn();
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: (...a: unknown[]) => publishToQueueMock(...a) }));

const selectResults: unknown[][] = [];
const auditValues = vi.fn();
const updateSetSpy = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => selectResults.shift() ?? [],
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: (v: unknown) => { auditValues(v); return Promise.resolve(); } })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSetSpy(v);
        return { where: () => Promise.resolve() };
      },
    })),
  },
}));

import { cleanupOrphanedAvatars } from '../lib/avatarCleanup';

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/q';
  deleteFileMock.mockImplementation(async (_t: string, id: string) => `key/${id}`);
});

describe('cleanupOrphanedAvatars', () => {
  it('deletes a pinned reference sheet, purges it and audits it, then marks the row deleted', async () => {
    selectResults.push([{ id: 'a1', attributes: { referenceSheetFileId: 'sheet-1' } }]);

    await cleanupOrphanedAvatars('t1');

    expect(deleteFileMock).toHaveBeenCalledWith('t1', 'sheet-1');
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/sheet-1' } });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', actorId: 'system', actorType: 'system', action: 'file_deleted', resource: 'file', resourceId: 'sheet-1',
    }));
    expect(updateSetSpy).toHaveBeenCalledWith({ status: 'deleted' });
  });

  it('only marks the row deleted when there is no pinned sheet', async () => {
    selectResults.push([{ id: 'a1', attributes: {} }]);

    await cleanupOrphanedAvatars('t1');

    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
    expect(updateSetSpy).toHaveBeenCalledWith({ status: 'deleted' });
  });

  it('keeps processing the next row when one deleteFile rejects, and never throws', async () => {
    selectResults.push([
      { id: 'a1', attributes: { referenceSheetFileId: 'sheet-1' } },
      { id: 'a2', attributes: { referenceSheetFileId: 'sheet-2' } },
    ]);
    deleteFileMock.mockRejectedValueOnce(new Error('db blip')).mockImplementationOnce(async (_t: string, id: string) => `key/${id}`);

    await expect(cleanupOrphanedAvatars('t1')).resolves.toBeUndefined();

    expect(deleteFileMock).toHaveBeenCalledTimes(2);
    // Row a1 failed before its status update; row a2 still gets purged, audited and marked deleted.
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(publishToQueueMock).toHaveBeenCalledTimes(1);
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/sheet-2' } });
  });
});
