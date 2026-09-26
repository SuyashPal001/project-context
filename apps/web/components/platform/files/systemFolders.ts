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
