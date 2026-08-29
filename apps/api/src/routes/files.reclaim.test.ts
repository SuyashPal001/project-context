import { describe, it, expect } from 'vitest';
// Imported from files.quota, not files.reclaim: the reclaim module touches the
// database, whose client reads DATABASE_URL at import time. Policy constants
// stay in the pure module so they can be tested without one.
import { PRESIGN_EXPIRY_MS, abandonedBefore } from './files.quota';

describe('abandonedBefore', () => {
  it('is one hour behind now, matching the presign expiry', () => {
    // Sweeping anything younger would expire an upload that is still legitimately
    // in flight, and the client would get a 403 from S3 on a URL we just issued.
    const now = new Date('2026-08-29T12:00:00Z');
    expect(abandonedBefore(now)).toEqual(new Date('2026-08-29T11:00:00Z'));
  });

  it('uses the same constant the presign URL is signed with', () => {
    expect(PRESIGN_EXPIRY_MS).toBe(3600 * 1000);
  });
});
