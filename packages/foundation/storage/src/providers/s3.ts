import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from '../types';

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: { region: string; bucket: string; credentials?: { accessKeyId: string; secretAccessKey: string } }) {
    this.client = new S3Client({
      region: config.region,
      credentials: config.credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = config.bucket;
  }

  async getUploadUrl(key: string, contentType: string, expiresIn = 3600, size?: number): Promise<{ url: string }> {
    // ContentLength is only included when known. Signing it binds the body
    // length into the signature, so S3 rejects an upload of any other size and
    // a client cannot under-declare its size to slip past the quota gate.
    //
    // Passing it as undefined is not the same as omitting it — the signer would
    // still cover the header and every upload would 403.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ...(size === undefined ? {} : { ContentLength: size }),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url };
  }

  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async getObject(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    })
    const response = await this.client.send(command)
    const stream = response.Body
    if (!stream) throw new Error('Empty response body')

    const chunks: Uint8Array[] = []
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async deleteObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(command);
  }
}
