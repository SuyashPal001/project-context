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
}
