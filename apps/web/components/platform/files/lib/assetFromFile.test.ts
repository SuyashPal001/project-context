import { describe, it, expect } from 'vitest';
import { fileToAsset } from './assetFromFile';
import type { FileRecord } from '../types';

function makeFile(overrides: Partial<FileRecord>): FileRecord {
    return {
        id: 'file-1',
        tenantId: 't1',
        key: 'tenant/t1/file-1',
        filename: 'thing.bin',
        contentType: 'application/octet-stream',
        size: 1024,
        uploadedBy: 'u1',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        formatDetected: null,
        workspaceName: null,
        classification: 'unclassified',
        chunkCount: 0,
        ingestionStatus: 'pending',
        extractedFields: null,
        personFolderId: null,
        ...overrides,
    };
}

describe('fileToAsset', () => {
    it('carries the file id through as fileId so the lightbox can resolve a URL', () => {
        const asset = fileToAsset(makeFile({ id: 'abc' }));
        expect(asset.fileId).toBe('abc');
        expect(asset.id).toBe('abc');
    });

    it('maps by MIME type for media', () => {
        expect(fileToAsset(makeFile({ contentType: 'image/png' })).type).toBe('image');
        expect(fileToAsset(makeFile({ contentType: 'video/mp4' })).type).toBe('video');
        expect(fileToAsset(makeFile({ contentType: 'audio/wav' })).type).toBe('audio');
        expect(fileToAsset(makeFile({ contentType: 'application/pdf' })).type).toBe('pdf');
    });

    it('falls back to the extension when the MIME type is generic', () => {
        // Uploads from some browsers arrive as application/octet-stream.
        expect(fileToAsset(makeFile({ contentType: 'application/octet-stream', filename: 'clip.mp4' })).type).toBe('video');
        expect(fileToAsset(makeFile({ contentType: 'application/octet-stream', filename: 'notes.md' })).type).toBe('markdown');
        expect(fileToAsset(makeFile({ contentType: 'application/octet-stream', filename: 'report.pdf' })).type).toBe('pdf');
        expect(fileToAsset(makeFile({ contentType: 'application/octet-stream', filename: 'memo.docx' })).type).toBe('docx');
    });

    it('degrades to the plain file type when nothing can preview it', () => {
        expect(fileToAsset(makeFile({ contentType: 'application/zip', filename: 'bundle.zip' })).type).toBe('file');
        expect(fileToAsset(makeFile({ contentType: 'text/csv', filename: 'rows.csv' })).type).toBe('file');
    });

    it('preserves size and createdAt for the metadata sidebar', () => {
        const asset = fileToAsset(makeFile({ size: 4096, createdAt: '2026-01-02T03:04:05.000Z' }));
        expect(asset.size).toBe(4096);
        expect(asset.createdAt).toBe('2026-01-02T03:04:05.000Z');
    });
});
