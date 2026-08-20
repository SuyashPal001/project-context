import { api } from '@/lib/api';

const SVG_CONTENT_TYPE = 'image/svg+xml';

// Mirrors ImageUpload.tsx's presigned-upload sequence exactly, so a
// custom-built avatar and a manually uploaded image go through the same
// storage path and are indistinguishable to the rest of the app once saved.
export async function saveAvatarAsset(svg: string, filename: string): Promise<{ url: string; fileId: string }> {
    // @ts-ignore - response shape from API, matches ImageUpload.tsx's usage
    const { data } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename,
        contentType: SVG_CONTENT_TYPE,
    });

    const blob = new Blob([svg], { type: SVG_CONTENT_TYPE });
    const uploadRes = await fetch(data.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': SVG_CONTENT_TYPE },
    });
    if (!uploadRes.ok) throw new Error('Failed to upload to S3');

    await api.post(`/api/v1/files/${data.fileId}/confirm`, { size: blob.size });

    const { presignedUrl } = await api.get<{ presignedUrl: string }>(
        `/api/v1/files/${data.fileId}/presigned-url`
    );

    return { url: presignedUrl, fileId: data.fileId };
}
