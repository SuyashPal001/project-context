import { describe, it, expect, vi, afterEach } from 'vitest';
import { assetToAttachment, uploadToS3 } from './useFileUpload';
import type { Asset } from '@/types/assets';

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({
      data: { fileId: 'file-1', uploadUrl: 'https://s3.example.com/signed', key: 'k' },
    }),
  },
}));

describe('assetToAttachment', () => {
  it('maps a video Asset into the Attachment shape used by AttachmentStrip', () => {
    const asset: Asset = {
      id: 'file-1',
      type: 'video',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      thumbnailUrl: 'https://example.com/clip.mp4',
      size: 2048,
      createdAt: '2026-08-01T00:00:00Z',
      sourceMessageId: 'm1',
      fileId: 'file-1',
    };

    expect(assetToAttachment(asset)).toEqual({
      fileId: 'file-1',
      name: 'clip.mp4',
      type: 'video/mp4',
      size: 2048,
      previewUrl: 'https://example.com/clip.mp4',
    });
  });

  it('falls back to the asset id as fileId for artifact-type assets', () => {
    const asset: Asset = {
      id: 'prd-1',
      type: 'prd',
      filename: 'Onboarding PRD',
      createdAt: '2026-08-01T00:00:00Z',
      sourceMessageId: 'm2',
      entityId: 'prd-1',
    };

    expect(assetToAttachment(asset).fileId).toBe('prd-1');
  });
});

describe('uploadToS3', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries the S3 PUT on a transient network failure and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const fileId = await uploadToS3(new Blob(['x']), 'done.webp', 'image/webp', 1);

    expect(fileId).toBe('file-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up and throws after exhausting retries on repeated network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadToS3(new Blob(['x']), 'done.webp', 'image/webp', 1))
      .rejects.toThrow('Failed to upload to S3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a definitive 4xx rejection from S3', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadToS3(new Blob(['x']), 'done.webp', 'image/webp', 1))
      .rejects.toThrow('Failed to upload to S3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
