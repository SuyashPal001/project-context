import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { expandArchive, isArchive, ingestFile } from '../services/ingestion';

async function makeZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('isArchive', () => {
  it('recognises a .zip filename', () => {
    expect(isArchive('corpus.zip', 'application/zip')).toBe(true);
  });

  it('recognises a zip mime type regardless of filename casing', () => {
    expect(isArchive('CORPUS.ZIP', 'application/x-zip-compressed')).toBe(true);
  });

  it('does not treat a pdf as an archive', () => {
    expect(isArchive('report.pdf', 'application/pdf')).toBe(false);
  });
});

describe('expandArchive', () => {
  it('returns one entry per supported file in the archive', async () => {
    const buffer = await makeZip({ 'a.txt': 'alpha', 'b.txt': 'bravo' });

    const entries = await expandArchive(buffer);

    expect(entries.map(e => e.filename).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('preserves the content of each extracted file', async () => {
    const buffer = await makeZip({ 'a.txt': 'alpha' });

    const [entry] = await expandArchive(buffer);

    expect(entry.buffer.toString('utf8')).toBe('alpha');
  });

  it('flattens nested directories to their file entries', async () => {
    const buffer = await makeZip({ 'docs/deep/a.txt': 'alpha' });

    const entries = await expandArchive(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('a.txt');
  });

  it('skips macOS resource fork entries', async () => {
    const buffer = await makeZip({
      '__MACOSX/._a.txt': 'junk',
      'a.txt': 'alpha',
    });

    const entries = await expandArchive(buffer);

    expect(entries.map(e => e.filename)).toEqual(['a.txt']);
  });

  it('skips files whose extension the pipeline cannot ingest', async () => {
    const buffer = await makeZip({ 'a.txt': 'alpha', 'photo.heic': 'binary' });

    const entries = await expandArchive(buffer);

    expect(entries.map(e => e.filename)).toEqual(['a.txt']);
  });

  it('does not recurse into a nested archive', async () => {
    const inner = await makeZip({ 'inner.txt': 'deep' });
    const zip = new JSZip();
    zip.file('nested.zip', inner);
    zip.file('a.txt', 'alpha');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const entries = await expandArchive(buffer);

    expect(entries.map(e => e.filename)).toEqual(['a.txt']);
  });

  it('rejects an archive holding more files than the per-upload limit', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 201; i++) entries[`f${i}.txt`] = 'x';
    const buffer = await makeZip(entries);

    await expect(expandArchive(buffer)).rejects.toThrow(/too many files/i);
  });

  it('rejects an archive whose contents exceed the uncompressed size limit', async () => {
    const buffer = await makeZip({ 'big.txt': 'x'.repeat(60 * 1024 * 1024) });

    await expect(expandArchive(buffer)).rejects.toThrow(/too large/i);
  });

  it('reports a corrupt archive as a readable error', async () => {
    await expect(expandArchive(Buffer.from('not a zip at all'))).rejects.toThrow(
      /could not be read/i
    );
  });
});

describe('ingestFile with an archive', () => {
  it('reports the archive format rather than Unknown', async () => {
    const buffer = await makeZip({ 'a.txt': 'alpha' });

    const result = await ingestFile('corpus.zip', 'application/zip', buffer);

    expect(result.formatDetected).toBe('Archive (zip)');
  });

  it('counts chunks across every file in the archive', async () => {
    // 5000 chars at a 1000-char window with 200 overlap = 7 chunks per file.
    const single = await makeZip({ 'a.txt': 'x'.repeat(5000) });
    const double = await makeZip({ 'a.txt': 'x'.repeat(5000), 'b.txt': 'x'.repeat(5000) });

    const one = await ingestFile('one.zip', 'application/zip', single);
    const two = await ingestFile('two.zip', 'application/zip', double);

    expect(one.chunkCount).toBe(7);
    expect(two.chunkCount).toBe(14);
  });

  it('reports how many member files were ingested', async () => {
    const buffer = await makeZip({ 'a.txt': 'alpha', 'b.txt': 'bravo' });

    const result = await ingestFile('corpus.zip', 'application/zip', buffer);

    expect(result.memberCount).toBe(2);
  });

  it('rejects an archive with no ingestible files', async () => {
    const buffer = await makeZip({ 'photo.heic': 'binary' });

    await expect(ingestFile('corpus.zip', 'application/zip', buffer)).rejects.toThrow(
      /no supported/i
    );
  });
});
