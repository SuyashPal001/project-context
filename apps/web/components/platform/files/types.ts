export interface ExtractedField {
    key: string;
    label: string;
    value: string;
    confidence: number;
}

export interface FileRecord {
    id: string;
    tenantId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
    uploadedBy: string;
    createdAt: string;
    updatedAt: string;
    formatDetected: string | null;
    workspaceName: string | null;
    classification: string;
    chunkCount: number;
    ingestionStatus: 'pending' | 'processing' | 'done' | 'failed';
    extractedFields: ExtractedField[] | null;
    personFolderId: string | null;
}

export interface FolderCard {
    folderName: string;
    folderPrefix: string;
    allDone: boolean;
    isIngesting: boolean;
    /** Files directly under this prefix — gates Add to chat against the attachment cap. */
    fileCount: number;
    /** Aggregates over the same files, so the folder row can fill Size and Added
     *  instead of spanning past them. */
    totalSize: number;
    latestAddedAt: string | null;
    /** Newest files in the folder, for the grid tile's stacked preview. */
    previewFiles: FileRecord[];
    /** The owning chat's title, for a generated/<conversationId>/ folder whose
     *  chat still exists — undefined for every other folder, and for one whose
     *  chat was deleted, so the view falls back to `folderName` (the raw id). */
    displayName?: string;
    /** The chat that produced this folder, when it's a generated/<conversationId>/
     *  one — handed to AddToChatMenu so it can pin that chat in the picker.
     *  `folderName`/`folderPrefix` stay the real key for navigation, deletion
     *  and grants; this only ever affects what's shown or pre-selected. */
    sourceConversationId?: string;
}
