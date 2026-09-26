import { api } from '@/lib/api';
import type { Attachment } from '@/types/agent-events';

export async function storeCreativeImage(file: File, prefix: string): Promise<Attachment> {
    const key = `${prefix}${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const { data: upload } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename: file.name, contentType: file.type, key, size: file.size,
    });
    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error('Image upload failed.');
    await api.post(`/api/v1/files/${upload.fileId}/confirm`, { size: file.size });
    return { fileId: upload.fileId, name: file.name, type: file.type, size: file.size };
}
