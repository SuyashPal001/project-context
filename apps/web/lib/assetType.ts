import type { AssetType } from '@/types/assets';

// The single classifier for "what kind of file is this" across the app: the
// Drive grid, the chat composer tray, and the chat-history attachment cards
// all resolve their icon, tint and badge from the AssetType this returns.
//
// MIME first, extension second: S3 uploads from some browsers arrive as
// application/octet-stream, so the content type alone would strand real media
// on the no-preview branch.
const EXTENSION_TYPES: Record<string, AssetType> = {
    mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', mkv: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
    pdf: 'pdf',
    docx: 'docx',
    csv: 'csv',
    md: 'markdown', markdown: 'markdown',
};

export function assetTypeForFile(contentType: string, filename: string): AssetType {
    const ct = contentType.toLowerCase();

    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('video/')) return 'video';
    if (ct.startsWith('audio/')) return 'audio';
    if (ct === 'application/pdf') return 'pdf';
    if (ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (ct === 'text/markdown') return 'markdown';
    if (ct === 'text/csv') return 'csv';

    const ext = filename.toLowerCase().split('.').pop() ?? '';
    // 'file' is the lightbox's no-preview branch — a download link, not a blank pane.
    return EXTENSION_TYPES[ext] ?? 'file';
}
