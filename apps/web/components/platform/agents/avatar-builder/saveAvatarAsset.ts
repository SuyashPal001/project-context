import { api } from '@/lib/api';

const SVG_CONTENT_TYPE = 'image/svg+xml';

// Mirrors ImageUpload.tsx's presigned-upload sequence exactly, so a
// custom-built avatar and a manually uploaded image go through the same
// storage path and are indistinguishable to the rest of the app once saved.
export async function saveAvatarAsset(svg: string, filename: string): Promise<{ url: string; fileId: string }> {
    // Built before the presign, not after: the upload request must declare the
    // byte size, which is signed into the URL.
    const blob = new Blob([svg], { type: SVG_CONTENT_TYPE });

    // @ts-ignore - response shape from API, matches ImageUpload.tsx's usage
    const { data } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename,
        contentType: SVG_CONTENT_TYPE,
        size: blob.size,
    });

    const uploadRes = await fetch(data.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': SVG_CONTENT_TYPE },
    });
    if (!uploadRes.ok) throw new Error('Failed to upload to S3');

    // The confirm response's fileId is authoritative, not the upload response's: when
    // the S3 key collides with an already-uploaded file (guaranteed here, since the
    // filename is always `{agentName}_avatar.svg` — every re-save of the same agent's
    // avatar collides), /confirm dedupes by discarding this pending record and
    // returning the existing file's id instead. Using data.fileId past this point
    // would fetch a presigned URL for a file that was just soft-deleted.
    const { fileId: confirmedFileId } = await api.post<{ success: boolean; fileId: string }>(
        `/api/v1/files/${data.fileId}/confirm`, { size: blob.size }
    );

    const { presignedUrl } = await api.get<{ presignedUrl: string }>(
        `/api/v1/files/${confirmedFileId}/presigned-url`
    );

    return { url: presignedUrl, fileId: confirmedFileId };
}
