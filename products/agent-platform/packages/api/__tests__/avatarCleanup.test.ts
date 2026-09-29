import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteFileMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { deleteFile: (...a: unknown[]) => deleteFileMock(...a) } }));
const publishToQueueMock = vi.fn();
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: (...a: unknown[]) => publishToQueueMock(...a) }));

const selectResults: unknown[][] = [];
const auditValues = vi.fn();
const updateSetSpy = vi.fn();
// One entry per db.update(...).where(...).returning() call, in order. Default
// (queue exhausted) is "claimed" — a single-row array — so existing tests
// that don't care about the race need not push anything.
const claimResults: unknown[][] = [];
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => selectResults.shift() ?? [],
          }),
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: (v: unknown) => { auditValues(v); return Promise.resolve(); } })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSetSpy(v);
        return {
          where: () => ({
            returning: async () => claimResults.shift() ?? [{ id: 'claimed' }],
          }),
        };
      },
    })),
  },
}));

import { cleanupOrphanedAvatars } from '../lib/avatarCleanup';

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  claimResults.length = 0;
  process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/q';
  deleteFileMock.mockImplementation(async (_t: string, id: string) => `key/${id}`);
});

describe('cleanupOrphanedAvatars', () => {
  it('claims the row, then deletes a pinned reference sheet, purges it and audits it', async () => {
    selectResults.push([{ id: 'a1', attributes: { referenceSheetFileId: 'sheet-1' } }]);

    await cleanupOrphanedAvatars('t1');

    expect(updateSetSpy).toHaveBeenCalledWith({ status: 'deleted' });
    expect(deleteFileMock).toHaveBeenCalledWith('t1', 'sheet-1');
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/sheet-1' } });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', actorId: 'system', actorType: 'system', action: 'file_deleted', resource: 'file', resourceId: 'sheet-1',
    }));
  });

  it('only claims the row when there is no pinned sheet', async () => {
    selectResults.push([{ id: 'a1', attributes: {} }]);

    await cleanupOrphanedAvatars('t1');

    expect(updateSetSpy).toHaveBeenCalledWith({ status: 'deleted' });
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });

  it('keeps processing the next row when one deleteFile rejects, and never throws', async () => {
    selectResults.push([
      { id: 'a1', attributes: { referenceSheetFileId: 'sheet-1' } },
      { id: 'a2', attributes: { referenceSheetFileId: 'sheet-2' } },
    ]);
    deleteFileMock.mockRejectedValueOnce(new Error('db blip')).mockImplementationOnce(async (_t: string, id: string) => `key/${id}`);

    await expect(cleanupOrphanedAvatars('t1')).resolves.toBeUndefined();

    expect(deleteFileMock).toHaveBeenCalledTimes(2);
    // Both rows were claimed (claim happens before the delete attempt); only
    // a2's delete succeeded, so only its purge/audit fired.
    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    expect(publishToQueueMock).toHaveBeenCalledTimes(1);
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/q', { type: 'storage.purge', payload: { tenantId: 't1', key: 'key/sheet-2' } });
  });

  // Finding #5: two concurrent cleanup runs racing on the same orphan must not
  // both delete/purge/audit the same sheet — only the run whose claim UPDATE
  // actually flips a row (RETURNING a row) proceeds.
  it('does nothing when the claim returns no row — another run already claimed it', async () => {
    selectResults.push([{ id: 'a1', attributes: { referenceSheetFileId: 'sheet-1' } }]);
    claimResults.push([]); // lost the race: 0 rows updated

    await cleanupOrphanedAvatars('t1');

    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });
});
