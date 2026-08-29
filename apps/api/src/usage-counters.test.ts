import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
vi.mock('@serverless-saas/database', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));

const registerUsageCounter = vi.fn();
vi.mock('@serverless-saas/entitlements', () => ({ registerUsageCounter }));

describe('registerFoundationCounters', () => {
  beforeEach(() => {
    vi.resetModules();
    registerUsageCounter.mockClear();
  });

  it('registers storage_gb exactly once even if called twice', async () => {
    const { registerFoundationCounters } = await import('./usage-counters');
    registerFoundationCounters();
    registerFoundationCounters();
    expect(registerUsageCounter).toHaveBeenCalledTimes(1);
    expect(registerUsageCounter).toHaveBeenCalledWith('storage_gb', expect.any(Function));
  });
});

describe('sumTenantStorageBytes', () => {
  beforeEach(() => {
    vi.resetModules();
    selectMock.mockReset();
  });

  it('parses the bigint sum, which postgres returns as a string', async () => {
    // sum() over an integer column returns bigint; the driver hands it back as
    // a string. Returning it unparsed makes every comparison a string compare.
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ total: '21474836480' }]) }),
    });
    const { sumTenantStorageBytes } = await import('./usage-counters');
    await expect(sumTenantStorageBytes('tenant-1')).resolves.toBe(21474836480);
  });

  it('returns 0 for a tenant with no files', async () => {
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ total: '0' }]) }),
    });
    const { sumTenantStorageBytes } = await import('./usage-counters');
    await expect(sumTenantStorageBytes('tenant-1')).resolves.toBe(0);
  });
});
