import { describe, it, expect } from 'vitest';
import { assetTypeForFile } from './assetType';

describe('assetTypeForFile', () => {
  it('classifies by MIME type when the browser reports one', () => {
    expect(assetTypeForFile('audio/mpeg', 'Rising Dust.mp3')).toBe('audio');
    expect(assetTypeForFile('video/mp4', 'clip.mp4')).toBe('video');
    expect(assetTypeForFile('image/png', 'shot.png')).toBe('image');
    expect(assetTypeForFile('application/pdf', 'spec.pdf')).toBe('pdf');
    expect(assetTypeForFile('text/csv', 'data.csv')).toBe('csv');
    expect(assetTypeForFile('text/markdown', 'notes.md')).toBe('markdown');
    expect(assetTypeForFile(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
    )).toBe('docx');
  });

  // The reason chat's old classifier got this wrong: S3 uploads from some
  // browsers arrive as application/octet-stream, and MIME-only logic stranded
  // every one of them on the generic grey document icon.
  it('falls back to the extension when the MIME type is uninformative', () => {
    expect(assetTypeForFile('application/octet-stream', 'Rising Dust.mp3')).toBe('audio');
    expect(assetTypeForFile('application/octet-stream', 'clip.mov')).toBe('video');
    expect(assetTypeForFile('', 'photo.HEIC'.replace('HEIC', 'jpeg'))).toBe('image');
    expect(assetTypeForFile('application/octet-stream', 'data.csv')).toBe('csv');
  });

  it('is case-insensitive for both MIME type and extension', () => {
    expect(assetTypeForFile('AUDIO/MPEG', 'song.mp3')).toBe('audio');
    expect(assetTypeForFile('application/octet-stream', 'SONG.MP3')).toBe('audio');
  });

  it('returns the no-preview "file" type for anything unrecognised', () => {
    expect(assetTypeForFile('application/octet-stream', 'archive.zip')).toBe('file');
    expect(assetTypeForFile('application/x-thing', 'noextension')).toBe('file');
  });
});
