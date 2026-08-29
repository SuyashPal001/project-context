import { describe, it, expect, vi, afterEach } from 'vitest';
import { assetToAttachment, uploadToS3, resolveFilesToUpload, MAX_FILES_PER_SELECTION } from './useFileUpload';
import { api } from '@/lib/api';
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

  it('uses the fileId from the /confirm response, not the original /upload fileId, since the server may dedup a same-key upload to a different live file', async () => {
    vi.mocked(api.post)
      .mockImplementationOnce(async () => ({
        data: { fileId: 'file-new', uploadUrl: 'https://s3.example.com/signed', key: 'done.webp' },
      }) as any) // /upload
      .mockImplementationOnce(async () => ({ success: true, fileId: 'file-existing' }) as any); // /confirm — server deduped

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const fileId = await uploadToS3(new Blob(['x']), 'done.webp', 'image/webp', 1);

    expect(fileId).toBe('file-existing');
  });

  it('sends a unique key per upload, so same-named chat attachments never collide on S3', async () => {
    vi.mocked(api.post).mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await uploadToS3(new Blob(['x']), 'done.webp', 'image/webp', 1);
    await uploadToS3(new Blob(['y']), 'done.webp', 'image/webp', 1);

    const uploadCalls = vi.mocked(api.post).mock.calls.filter(([path]) => path === '/api/v1/files/upload');
    expect(uploadCalls).toHaveLength(2);
    const [firstKey, secondKey] = uploadCalls.map(([, body]) => body.key);
    expect(firstKey).toContain('done.webp');
    expect(secondKey).toContain('done.webp');
    expect(firstKey).not.toBe(secondKey);
  });

  it('declares the byte size on the presign request', async () => {
    // The size is signed into the upload URL, so a caller that omits it gets no
    // quota enforcement at all — every call site has to send it.
    // Only the recorded call matters here, so the suite's shared default mock
    // is left in place — replacing its resolved value would leak into whichever
    // test runs next. Clearing the call log is enough.
    vi.mocked(api.post).mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await uploadToS3(new Blob(['x']), 'a.png', 'image/png', 4321);

    const [, body] = vi.mocked(api.post).mock.calls.find(([path]) => path === '/api/v1/files/upload')!;
    expect(body).toMatchObject({ size: 4321 });
  });

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

function makeFileList(names: string[]): FileList {
  const files = names.map(name => new File(['x'], name, { type: 'image/png' }));
  return {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () { yield* files; },
  } as unknown as FileList;
}

describe('resolveFilesToUpload', () => {
  it('returns null (nothing selected) when the FileList is empty or missing', () => {
    expect(resolveFilesToUpload(null)).toEqual({ files: null, error: null });
    expect(resolveFilesToUpload(makeFileList([]))).toEqual({ files: null, error: null });
  });

  it('returns the files as an array when within the cap', () => {
    const list = makeFileList(['a.png', 'b.png']);
    const result = resolveFilesToUpload(list);
    expect(result.error).toBeNull();
    expect(result.files?.map(f => f.name)).toEqual(['a.png', 'b.png']);
  });

  it(`allows exactly ${MAX_FILES_PER_SELECTION} files`, () => {
    const list = makeFileList(Array.from({ length: MAX_FILES_PER_SELECTION }, (_, i) => `f${i}.png`));
    const result = resolveFilesToUpload(list);
    expect(result.error).toBeNull();
    expect(result.files).toHaveLength(MAX_FILES_PER_SELECTION);
  });

  it(`rejects with an error, selecting nothing, when over ${MAX_FILES_PER_SELECTION} files are picked`, () => {
    const list = makeFileList(Array.from({ length: MAX_FILES_PER_SELECTION + 1 }, (_, i) => `f${i}.png`));
    const result = resolveFilesToUpload(list);
    expect(result.files).toBeNull();
    expect(result.error).toBe(`You can attach up to ${MAX_FILES_PER_SELECTION} files at once.`);
  });
});
