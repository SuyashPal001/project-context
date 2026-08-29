import { describe, it, expect, vi, beforeEach } from 'vitest';

function res(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('saveAvatarAsset', () => {
    it('runs the presigned upload sequence and returns the final display URL', async () => {
        fetchMock
            // 1. POST /api/v1/files/upload
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            // 2. PUT to S3
            .mockResolvedValueOnce(res(200))
            // 3. POST /api/v1/files/file-1/confirm
            .mockResolvedValueOnce(res(200, { success: true, fileId: 'file-1' }))
            // 4. GET /api/v1/files/file-1/presigned-url
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        const result = await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        expect(result).toEqual({ url: 'https://s3.example/display-url', fileId: 'file-1' });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('declares the SVG byte size on the presign request', async () => {
        // The size is signed into the upload URL, so omitting it means no quota
        // enforcement for this path at all.
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, { success: true, fileId: 'file-1' }))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const svg = '<svg></svg>';
        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset(svg, 'agent-avatar.svg');

        const presignBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(presignBody.size).toBe(new Blob([svg]).size);
    });

    it('uploads the SVG to S3 with an image/svg+xml content type', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, { success: true, fileId: 'file-1' }))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        const [s3Url, s3Options] = fetchMock.mock.calls[1];
        expect(s3Url).toBe('https://s3.example/put-url');
        expect(s3Options.method).toBe('PUT');
        expect(s3Options.headers['Content-Type']).toBe('image/svg+xml');
    });

    it('requests the upload URL with the given filename and svg content type', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, { success: true, fileId: 'file-1' }))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        const [, uploadOptions] = fetchMock.mock.calls[0];
        const body = JSON.parse(uploadOptions.body);
        expect(body).toEqual({
            filename: 'agent-avatar.svg',
            contentType: 'image/svg+xml',
            size: new Blob(['<svg></svg>']).size,
        });
    });

    it('uses the confirm response fileId, not the upload response fileId, when the S3 key dedupes to an existing file', async () => {
        // The filename is always `{agentName}_avatar.svg`, so re-saving an agent's
        // avatar always collides with its prior upload's S3 key. /confirm detects
        // this, soft-deletes the new pending record, and returns the pre-existing
        // file's id instead — fetching a presigned URL for the original (now
        // deleted) fileId would 404.
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-new-pending', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, { success: true, fileId: 'file-existing' }))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        const result = await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        expect(result).toEqual({ url: 'https://s3.example/display-url', fileId: 'file-existing' });
        const [presignedUrlPath] = fetchMock.mock.calls[3];
        expect(presignedUrlPath).toContain('/files/file-existing/presigned-url');
    });

    it('throws if the S3 PUT fails', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(500));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await expect(saveAvatarAsset('<svg></svg>', 'agent-avatar.svg')).rejects.toThrow('Failed to upload to S3');
    });
});
