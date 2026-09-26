// Storage prefixes the platform writes to automatically (chat uploads, the
// creative library, generated media) aren't real user folders — they're
// implementation detail that used to leak into Drive as empty-looking folder
// tiles. Surfaced as pills instead so the raw prefix name never shows.
export const SYSTEM_FOLDER_LABELS: Record<string, string> = {
    'chat-attachments': 'Uploads',
    'creative-avatars': 'Avatars',
    'creative-products': 'Products',
    'generated': 'Generated',
};

export function isSystemFolder(folderName: string): boolean {
    return Object.hasOwn(SYSTEM_FOLDER_LABELS, folderName);
}

// Singular verb-phrase for the upload CTA, keyed by the same system-folder
// name — "Upload avatar" reads better than "Upload" + the plural pill label.
const UPLOAD_LABELS: Record<string, string> = {
    'creative-avatars': 'Upload avatar',
    'creative-products': 'Upload product',
};

/** currentPrefix is the raw storage prefix (e.g. "creative-avatars/"), same
 *  shape used for navigation — this reads its first segment the same way the
 *  breadcrumb does. Falls back to "Add Files" inside a plain user folder
 *  (one with no special label) and "Upload" at the root. */
export function uploadLabelForPrefix(prefix: string): string {
    if (!prefix) return 'Upload';
    const folderName = prefix.split('/')[0];
    return UPLOAD_LABELS[folderName] ?? 'Add Files';
}
