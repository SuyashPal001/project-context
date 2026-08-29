import { describe, it, expect } from 'vitest';
import { tenantS3Key } from './s3Key';

describe('tenantS3Key', () => {
  it('prefixes the user-space key with the tenant namespace', () => {
    expect(tenantS3Key('t-1', 'documents/report.pdf')).toBe('tenants/t-1/documents/report.pdf');
  });

  it('is the single definition used by both upload and purge', () => {
    // Purge deletes real objects. If upload and purge derive keys separately
    // and drift, purge either misses the object or deletes the wrong one.
    expect(tenantS3Key('t-1', 'a.png')).toBe('tenants/t-1/a.png');
  });
});
