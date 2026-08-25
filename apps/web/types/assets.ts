export type AssetType = 'video' | 'audio' | 'image' | 'markdown' | 'pdf' | 'docx' | 'csv' | 'file' | 'prd' | 'roadmap' | 'tasks';

export interface Asset {
  id: string;
  type: AssetType;
  filename: string;
  /** Original MIME type — present for video/audio/image/file/markdown assets, absent for prd/roadmap/tasks. */
  mimeType?: string;
  thumbnailUrl?: string;
  size?: number;
  createdAt: string;
  sourceMessageId: string;
  /** Present for uploaded/generated files — resolves a download URL via GET /api/v1/files/:fileId/presigned-url */
  fileId?: string;
  /** Present for prd/roadmap/tasks — feeds GET /api/v1/prds/:id or /api/v1/plans/:id */
  entityId?: string;
}

export interface AssetsResponse {
  data: Asset[];
}
