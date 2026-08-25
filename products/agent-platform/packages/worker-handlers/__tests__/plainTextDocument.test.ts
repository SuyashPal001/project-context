import { describe, it, expect } from 'vitest';
import { isPlainTextDocument } from '../handlers/extractText';

// apps/api's isIngestibleDocument enqueues pdf, docx, txt and csv for ingest.
// Anything it enqueues that the extractor cannot read reaches the orchestrator
// with no extractedText, where embedStep throws "No text content extracted —
// 0 chunks produced" and the file is marked failed. So the extractor's notion
// of readable text has to be at least as wide as that gate's.
describe('isPlainTextDocument', () => {
    it('reads a .txt — the case that was silently failing every ingest', () => {
        expect(isPlainTextDocument('text/plain', 'notes.txt')).toBe(true);
    });

    it('reads a .csv', () => {
        expect(isPlainTextDocument('text/csv', 'rows.csv')).toBe(true);
    });

    it('falls back to the extension when the upload declared a generic type', () => {
        expect(isPlainTextDocument('application/octet-stream', 'notes.txt')).toBe(true);
        expect(isPlainTextDocument('application/octet-stream', 'rows.csv')).toBe(true);
    });

    it('covers other text/* types rather than enumerating each one', () => {
        expect(isPlainTextDocument('text/markdown', 'readme.md')).toBe(true);
    });

    it('leaves binary formats to their own parsers', () => {
        expect(isPlainTextDocument('application/pdf', 'report.pdf')).toBe(false);
        expect(isPlainTextDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx')).toBe(false);
        expect(isPlainTextDocument('image/png', 'scan.png')).toBe(false);
    });
});
