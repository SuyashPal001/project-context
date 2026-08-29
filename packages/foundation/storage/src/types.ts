export interface StorageProvider {
  getUploadUrl(key: string, contentType: string, expiresIn?: number, size?: number): Promise<{ url: string }>;
  getDownloadUrl(key: string, expiresIn?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface UploadUrlRequest {
  tenantId: string;
  filename: string;
  contentType: string;
  uploadedBy: string;
  /** User-space key (e.g. "documents/report.pdf"). Generated from filename if omitted. */
  userKey?: string;
  /**
   * Declared byte size. When given it is signed into the URL, so S3 rejects a
   * body of any other length. Optional only for the migration window while
   * callers are updated to send it.
   */
  size?: number;
}

export interface UploadUrlResponse {
  fileId: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
}
