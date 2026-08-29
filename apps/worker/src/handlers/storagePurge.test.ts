import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteObject = vi.fn();
vi.mock('@serverless-saas/storage', () => ({
  storageService: { deleteObjectForTenant: (...a: unknown[]) => deleteObject(...a) },
}));

import { handleStoragePurge } from './storagePurge';

describe('handleStoragePurge', () => {
  beforeEach(() => {
    deleteObject.mockReset();
  });

  it('deletes the object named in the payload', async () => {
    deleteObject.mockResolvedValue(undefined);
    await handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1', key: 'a.png' } });
    expect(deleteObject).toHaveBeenCalledWith('t-1', 'a.png');
  });

  it('ignores a malformed payload instead of failing the SQS batch', async () => {
    // A throw here fails the whole batch item and retries forever for what is
    // a no-op. The cache handler learned this the hard way.
    await expect(handleStoragePurge({ type: 'storage.purge' })).resolves.toBeUndefined();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('ignores a payload missing the key', async () => {
    await expect(
      handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1' } }),
    ).resolves.toBeUndefined();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('treats an already-absent object as success', async () => {
    // Purge must be idempotent: SQS redelivers, and the second delete of a key
    // that is already gone is the expected steady state, not an error.
    deleteObject.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    await expect(
      handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1', key: 'a.png' } }),
    ).resolves.toBeUndefined();
  });

  it('rethrows a real failure so SQS retries it', async () => {
    // An access-denied or network error is not idempotence — swallowing it
    // would silently leak the object it was supposed to delete.
    deleteObject.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));
    await expect(
      handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1', key: 'a.png' } }),
    ).rejects.toThrow(/AccessDenied/);
  });
});
