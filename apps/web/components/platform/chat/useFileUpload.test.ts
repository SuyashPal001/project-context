import { describe, it, expect } from 'vitest';
import { assetToAttachment } from './useFileUpload';
import type { Asset } from '@/types/assets';

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
