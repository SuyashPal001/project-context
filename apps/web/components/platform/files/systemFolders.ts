// Storage prefixes the platform writes to automatically (chat uploads, the
// creative library, generated media) aren't real user folders — they're
// implementation detail that used to leak into Drive as empty-looking folder
// tiles. Surfaced as pills instead so the raw prefix name never shows.
export const SYSTEM_FOLDER_LABELS: Record<string, string> = {
    'chat-attachments': 'Chat uploads',
    'creative-avatars': 'Avatars',
    'creative-products': 'Products',
    'generated': 'Generated',
    'imported-products': 'Imported products',
    'avatar-refs': 'Avatar references',
};

export function isSystemFolder(folderName: string): boolean {
    return Object.hasOwn(SYSTEM_FOLDER_LABELS, folderName);
}

// The folders that get their own pill. chat-attachments is a system folder too
// (hidden as a tile) but has no pill: it is part of "Uploads".
export const PILL_FOLDERS = ['creative-avatars', 'creative-products', 'generated'] as const;

const AGENT_OR_LIBRARY_PREFIXES = [...PILL_FOLDERS.map(folder => `${folder}/`), 'imported-products/', 'avatar-refs/'];

/** "Uploads": everything the user brought in themselves — chat attachments,
 *  their own folders and loose files — as opposed to agent output ("Generated")
 *  and the creative library, which have their own pills. */
export function isUpload(key: string): boolean {
    return !AGENT_OR_LIBRARY_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Where product photos live: uploaded ones and ones downloaded by a link import. */
export const PRODUCT_PREFIXES = ['creative-products/', 'imported-products/'] as const;

export function isProductFileKey(key: string): boolean {
    return PRODUCT_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Uploads plus product photos that no product uses anymore (e.g. after the
 *  product was deleted) — they're still the user's files. While the referenced
 *  ids are unknown (null), no product photo is shown, so none flash in. */
export function uploadsWithOrphanProductFiles<T extends { id: string; key: string }>(files: T[], referencedIds: Set<string> | null): T[] {
    return files.filter(f => isUpload(f.key) || (referencedIds !== null && isProductFileKey(f.key) && !referencedIds.has(f.id)));
}

/** The Products pill must always be reachable, even for a tenant whose product
 *  photos are all link imports (stored under imported-products/, which has no
 *  files under creative-products/) or who has no products yet — otherwise there
 *  is no way into DriveProducts. Order follows PILL_FOLDERS. */
export function withProductsPill(pills: string[]): string[] {
    const present = new Set(pills);
    present.add('creative-products');
    return PILL_FOLDERS.filter(folder => present.has(folder));
}

// Upload CTA label per system folder, so every pill has a matching action —
// "New avatar" reads better than "Upload" + the plural pill label.
const UPLOAD_LABELS: Record<string, string> = {
    'chat-attachments': 'Upload',
    'creative-avatars': 'New avatar',
    'creative-products': 'New product',
    'generated': 'Upload',
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

/** Why a new folder name can't be used, or null if it can. Folders are just key
 *  prefixes, so a slash would silently nest one and a platform name would turn
 *  the folder into that pill. */
export function folderNameError(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (/[\\/]/.test(trimmed)) return "Folder names can't contain slashes.";
    if (trimmed === '.' || trimmed === '..') return "That isn't a valid folder name.";
    if (isSystemFolder(trimmed.toLowerCase())) return 'That name is reserved for the platform.';
    return null;
}
