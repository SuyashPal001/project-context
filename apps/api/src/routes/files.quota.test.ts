import { describe, it, expect } from 'vitest';
import { GB_BYTES, MAX_FILE_BYTES, resolveStorageLimit, decideUpload } from './files.quota';

const FEATURE = 'feat-storage-gb';

describe('GB_BYTES', () => {
  // Guards the GB/GiB convention. If this flips to 1e9 the meter and the
  // enforcement path disagree about what a gigabyte is.
  it('is binary, not decimal', () => {
    expect(GB_BYTES).toBe(1073741824);
  });
});

describe('resolveStorageLimit', () => {
  it('refuses to guess when the entitlement map is missing entirely', () => {
    expect(() => resolveStorageLimit(undefined, FEATURE)).toThrow(/entitlements/i);
  });

  it('converts the plan limit from GB to bytes', () => {
    const result = resolveStorageLimit({ [FEATURE]: { valueLimit: 20 } }, FEATURE);
    expect(result).toEqual({ unlimited: false, limitBytes: 20 * 1073741824 });
  });

  it('reports unlimited without inventing a byte limit', () => {
    const result = resolveStorageLimit({ [FEATURE]: { unlimited: true } }, FEATURE);
    expect(result).toEqual({ unlimited: true, limitBytes: 0 });
  });

  it('treats a present map that lacks the feature as a real zero grant', () => {
    // Distinct from the missing-map case above: this plan genuinely grants no
    // storage, which is an answer, not a wiring error.
    const result = resolveStorageLimit({}, FEATURE);
    expect(result).toEqual({ unlimited: false, limitBytes: 0 });
  });
});

describe('decideUpload', () => {
  const limited = { unlimited: false, limitBytes: 20 * 1073741824 };

  it('allows a file that fits within remaining headroom', () => {
    expect(decideUpload({ size: 1000, usedBytes: 0, limit: limited })).toEqual({ allowed: true });
  });

  it('allows a file exactly at the per-file cap', () => {
    expect(decideUpload({ size: MAX_FILE_BYTES, usedBytes: 0, limit: limited })).toEqual({ allowed: true });
  });

  it('rejects one byte over the per-file cap', () => {
    expect(decideUpload({ size: MAX_FILE_BYTES + 1, usedBytes: 0, limit: limited })).toEqual({
      allowed: false, code: 'file_too_large', maxBytes: MAX_FILE_BYTES, size: MAX_FILE_BYTES + 1,
    });
  });

  it('allows a file that exactly fills the remaining quota', () => {
    const usedBytes = limited.limitBytes - 500;
    expect(decideUpload({ size: 500, usedBytes, limit: limited })).toEqual({ allowed: true });
  });

  it('rejects a file one byte beyond the remaining quota', () => {
    const usedBytes = limited.limitBytes - 500;
    expect(decideUpload({ size: 501, usedBytes, limit: limited })).toEqual({
      allowed: false, code: 'storage_quota_exceeded', usedBytes, limitBytes: limited.limitBytes, size: 501,
    });
  });

  it('checks the per-file cap before the quota', () => {
    // An oversized file on an already-full tenant should say the useful thing.
    const oversized = MAX_FILE_BYTES + 1;
    const result = decideUpload({ size: oversized, usedBytes: limited.limitBytes, limit: limited });
    expect(result).toMatchObject({ code: 'file_too_large' });
  });

  it('skips both gates when unlimited', () => {
    const unlimited = { unlimited: true, limitBytes: 0 };
    expect(decideUpload({ size: MAX_FILE_BYTES * 100, usedBytes: 1e15, limit: unlimited })).toEqual({ allowed: true });
  });
});
