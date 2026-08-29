import { describe, it, expect, vi } from 'vitest';

const putObjectCalls: Array<Record<string, unknown>> = [];

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { async send() { return {}; } },
  PutObjectCommand: class { constructor(input: Record<string, unknown>) { putObjectCalls.push(input); } },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => 'https://s3.test/signed',
}));

import { S3StorageProvider } from './s3';

describe('S3StorageProvider.getUploadUrl', () => {
  const provider = new S3StorageProvider({ bucket: 'b', region: 'r' });

  it('signs ContentLength when a size is given', async () => {
    putObjectCalls.length = 0;
    await provider.getUploadUrl('k', 'text/plain', 3600, 1234);
    expect(putObjectCalls[0]).toMatchObject({ Key: 'k', ContentType: 'text/plain', ContentLength: 1234 });
  });

  it('omits ContentLength entirely when no size is given', async () => {
    // Sending ContentLength: undefined is not the same as omitting it — the
    // signer would still cover the header and every upload would 403.
    putObjectCalls.length = 0;
    await provider.getUploadUrl('k', 'text/plain');
    expect(putObjectCalls[0]).not.toHaveProperty('ContentLength');
  });
});
