import { db } from '@serverless-saas/database';
import { files, storageProviders } from '@serverless-saas/database/schema';
import { eq, and, isNull, like } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3StorageProvider } from './providers/s3';
import { tenantS3Key } from './s3Key';
import type { StorageProvider, UploadUrlRequest, UploadUrlResponse } from './types';

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'ap-south-1' });
let cachedBucket: string | null = null;

async function getBucketFromSSM(): Promise<string> {
  if (cachedBucket) return cachedBucket;

  // Lambdas get the bucket injected directly; SSM is the fallback for other runtimes
  if (process.env.DOCUMENTS_BUCKET) {
    cachedBucket = process.env.DOCUMENTS_BUCKET;
    return cachedBucket;
  }

  const env = process.env.ENVIRONMENT || 'dev';
  const paramName = `/project-context/${env}/s3/documents-bucket-name`;

  const command = new GetParameterCommand({ Name: paramName });
  const result = await ssm.send(command);
  cachedBucket = result.Parameter?.Value || '';
  return cachedBucket;
}

export class StorageService {
  private async resolveProvider(tenantId: string): Promise<StorageProvider> {
    // Check for tenant-specific provider
    const [tenantProvider] = await db
      .select()
      .from(storageProviders)
      .where(and(
        eq(storageProviders.tenantId, tenantId),
        eq(storageProviders.isDefault, true)
      ))
      .limit(1);

    if (tenantProvider) {
      return new S3StorageProvider({
        region: tenantProvider.region || 'ap-south-1',
        bucket: tenantProvider.bucket,
      });
    }

    // Fall back to platform default
    const [platformProvider] = await db
      .select()
      .from(storageProviders)
      .where(and(
        isNull(storageProviders.tenantId),
        eq(storageProviders.isDefault, true)
      ))
      .limit(1);

    if (platformProvider) {
      return new S3StorageProvider({
        region: platformProvider.region || 'ap-south-1',
        bucket: platformProvider.bucket,
      });
    }

    // Fallback: resolve bucket name from SSM
    const bucket = await getBucketFromSSM();
    return new S3StorageProvider({
      region: process.env.AWS_REGION || 'ap-south-1',
      bucket,
    });
  }

  async getUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResponse> {
    const { tenantId, filename, contentType, uploadedBy, userKey, size } = request;

    // User-space key (used for folder browsing): e.g. "documents/report.pdf"
    // Full S3 key: tenants/{tenantId}/{userSpaceKey}
    const userSpaceKey = userKey || filename;
    const s3Key = tenantS3Key(tenantId, userSpaceKey);

    // Create file record with pending status
    const [file] = await db
      .insert(files)
      .values({
        tenantId,
        name: filename,
        key: userSpaceKey, // store user-space key so folder browser works
        mimeType: contentType,
        status: 'pending',
        uploadedBy,
      })
      .returning();

    // Get presigned URL
    const provider = await this.resolveProvider(tenantId);
    const { url } = await provider.getUploadUrl(s3Key, contentType, 3600, size);

    return {
      fileId: file.id,
      uploadUrl: url,
      key: userSpaceKey,
      expiresIn: 3600,
    };
  }

  async confirmUpload(tenantId: string, fileId: string, size: number): Promise<void> {
    await db
      .update(files)
      .set({ 
        status: 'uploaded', 
        size,
        uploadedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(files.id, fileId),
        eq(files.tenantId, tenantId)
      ));
  }

  async getDownloadUrl(tenantId: string, fileId: string): Promise<string> {
    const [file] = await db
      .select()
      .from(files)
      .where(and(
        eq(files.id, fileId),
        eq(files.tenantId, tenantId),
        isNull(files.deletedAt)
      ))
      .limit(1);

    if (!file) throw new Error('File not found');

    const provider = await this.resolveProvider(tenantId);
    const s3Key = tenantS3Key(tenantId, file.key);
    return provider.getDownloadUrl(s3Key);
  }

  async downloadFile(tenantId: string, fileId: string): Promise<Buffer> {
    const [file] = await db
      .select()
      .from(files)
      .where(and(
        eq(files.id, fileId),
        eq(files.tenantId, tenantId),
        isNull(files.deletedAt)
      ))
      .limit(1);

    if (!file) throw new Error(`File not found: ${fileId}`);

    const provider = await this.resolveProvider(tenantId) as S3StorageProvider;
    const s3Key = tenantS3Key(tenantId, file.key);
    return provider.getObject(s3Key);
  }

  /**
   * Removes the S3 object itself. The database row is the caller's business —
   * deleteFile soft-deletes it and enqueues this via the worker.
   */
  async deleteObjectForTenant(tenantId: string, userSpaceKey: string): Promise<void> {
    const provider = await this.resolveProvider(tenantId);
    await provider.deleteObject(tenantS3Key(tenantId, userSpaceKey));
  }

  /**
   * Soft-deletes the row and returns the key whose object should now be purged.
   *
   * The row is kept for audit and for the ingestion lineage that references it.
   * The object must not be: leaving it in S3 meant a tenant could upload to
   * their quota, delete, and repeat forever while the bill grew without limit,
   * because the quota counts `uploaded` rows and the bill counts objects.
   *
   * The purge is enqueued by the caller rather than here, so this package stays
   * a storage layer with no queue dependency. Returning null means nothing was
   * deleted — the caller must not purge, since the id may belong to another
   * tenant.
   */
  async deleteFile(tenantId: string, fileId: string): Promise<string | null> {
    const [row] = await db
      .update(files)
      .set({
        status: 'deleted',
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(files.id, fileId),
        eq(files.tenantId, tenantId)
      ))
      .returning({ key: files.key });

    return row?.key ?? null;
  }

  async listFiles(tenantId: string, limit = 50, offset = 0, prefix?: string): Promise<InferSelectModel<typeof files>[]> {
    return db
      .select()
      .from(files)
      .where(and(
        eq(files.tenantId, tenantId),
        eq(files.status, 'uploaded'),
        isNull(files.deletedAt),
        prefix ? like(files.key, `${prefix}%`) : undefined,
      ))
      .limit(limit)
      .offset(offset)
      .orderBy(files.createdAt);
  }
}

export const storageService = new StorageService();
