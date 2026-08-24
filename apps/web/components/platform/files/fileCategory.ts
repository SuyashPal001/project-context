export type FileCategory = 'document' | 'image' | 'audio-video' | 'archive' | 'other';

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
    document: 'Documents',
    image: 'Images',
    'audio-video': 'Audio & Video',
    archive: 'Archives',
    other: 'Other',
};

// Only documents go through the OCR/RAG ingest pipeline (see files.ts's /ingest
// route) — images, audio/video and archives are stored and browsable but never
// chunked, so ingest status/actions should never render for them.
export function getFileCategory(contentType: string, filename: string): FileCategory {
    const ct = contentType.toLowerCase();
    const name = filename.toLowerCase();

    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'audio-video';
    if (ct === 'application/zip' || ct === 'application/x-zip-compressed' || name.endsWith('.zip')) return 'archive';
    if (
        ct === 'application/pdf' || name.endsWith('.pdf') ||
        ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx') ||
        ct === 'text/plain' || name.endsWith('.txt') ||
        ct === 'text/csv' || name.endsWith('.csv')
    ) return 'document';

    return 'other';
}

export function isIngestibleCategory(category: FileCategory): boolean {
    return category === 'document';
}

export type TimeRange = 'all' | 'today' | '7d' | '30d' | 'older';

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
    all: 'Any time',
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    older: 'Older (30+ days ago)',
};

export function matchesTimeRange(createdAt: string, range: TimeRange): boolean {
    if (range === 'all') return true;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const day = 24 * 60 * 60 * 1000;
    if (range === 'today') return ageMs < day;
    if (range === '7d') return ageMs < 7 * day;
    if (range === '30d') return ageMs < 30 * day;
    return ageMs >= 30 * day;
}
