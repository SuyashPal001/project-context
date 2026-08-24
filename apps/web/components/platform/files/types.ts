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
    officeCode: string | null;
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
}
