import type { Asset } from '@/types/assets';
import { assetTypeForFile } from '@/lib/assetType';
import type { FileRecord } from '../types';

// Re-exported so Drive's existing importers keep their import path. The
// classifier itself lives in @/lib/assetType because chat shares it.
export { assetTypeForFile };

// Drive rows carry a FileRecord; the chat lightbox (components/platform/canvas/
// AssetLightbox) renders an Asset. The only real work is picking the AssetType,
// which decides which preview pane renders — everything else is a rename.
export function fileToAsset(file: FileRecord): Asset {
    return {
        id: file.id,
        type: assetTypeForFile(file.contentType, file.filename),
        filename: file.filename,
        mimeType: file.contentType,
        size: file.size,
        createdAt: file.createdAt,
        // Drive files have no originating chat message; the lightbox only reads
        // this field for chat-side navigation, which Drive doesn't use.
        sourceMessageId: '',
        fileId: file.id,
    };
}
