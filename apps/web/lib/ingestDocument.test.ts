import { describe, it, expect, vi } from 'vitest';
import { ingestDocument, isIngestibleDocument } from './ingestDocument';

function res(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function file(name: string, type: string, content = 'hello') {
  return new File([content], name, { type });
}

describe('isIngestibleDocument', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['notes.txt', 'text/plain'],
    ['corpus.zip', 'application/zip'],
  ])('accepts %s', (name, type) => {
    expect(isIngestibleDocument(file(name, type))).toBe(true);
  });

  it('rejects an image, which belongs on the message not in the knowledge base', () => {
    expect(isIngestibleDocument(file('photo.png', 'image/png'))).toBe(false);
  });
});

describe('ingestDocument', () => {
  it('registers the uploaded object and returns its document id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(201, { documentId: 'doc-1' }));

    const result = await ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl);

    expect(result).toEqual({ documentId: 'doc-1', duplicate: false });
  });

  it('sends a sha-256 content hash so the server can deduplicate', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(201, { documentId: 'doc-1' }));

    await ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl);

    const body = JSON.parse(fetchImpl.mock.calls[2][1].body);
    // sha-256 of "hello"
    expect(body.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('uploads the bytes to the presigned URL before registering', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(201, { documentId: 'doc-1' }));

    await ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl);

    expect(fetchImpl.mock.calls[1][0]).toBe('https://s3.test/put');
    expect(fetchImpl.mock.calls[1][1].method).toBe('PUT');
  });

  it('treats an already-ingested document as success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(409, { documentId: 'doc-existing' }));

    const result = await ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl);

    expect(result).toEqual({ documentId: 'doc-existing', duplicate: true });
  });

  it('reports a readable error when the upload URL is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(400));

    await expect(ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl)).rejects.toThrow(
      /upload url/i
    );
  });

  it('does not register the document when the S3 upload fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(500));

    await expect(ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl)).rejects.toThrow(/upload/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('ingestDocument duplicate without an id', () => {
  it('reports no document id when the server omits one', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { uploadUrl: 'https://s3.test/put', fileKey: 'k/1' }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(409, {}));

    const result = await ingestDocument(file('a.pdf', 'application/pdf'), fetchImpl);

    expect(result).toEqual({ documentId: undefined, duplicate: true });
  });
});
