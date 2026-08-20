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
            .mockResolvedValueOnce(res(200, {}))
            // 4. GET /api/v1/files/file-1/presigned-url
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        const result = await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        expect(result).toEqual({ url: 'https://s3.example/display-url', fileId: 'file-1' });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('uploads the SVG to S3 with an image/svg+xml content type', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, {}))
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
            .mockResolvedValueOnce(res(200, {}))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        const [, uploadOptions] = fetchMock.mock.calls[0];
        const body = JSON.parse(uploadOptions.body);
        expect(body).toEqual({ filename: 'agent-avatar.svg', contentType: 'image/svg+xml' });
    });

    it('throws if the S3 PUT fails', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(500));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await expect(saveAvatarAsset('<svg></svg>', 'agent-avatar.svg')).rejects.toThrow('Failed to upload to S3');
    });
});
