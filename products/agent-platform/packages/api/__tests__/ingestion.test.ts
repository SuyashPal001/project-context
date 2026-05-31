import { describe, it, expect } from 'vitest';
import { detectFormat, chunkText } from '../services/ingestion';

describe('detectFormat', () => {
  it('detects text PDF by mime type and non-empty text', () => {
    const result = detectFormat('pension.pdf', 'application/pdf', 500, 'Normal readable pension text here');
    expect(result).toBe('PDF (text)');
  });

  it('detects scanned PDF when text is too short', () => {
    const result = detectFormat('service_book.pdf', 'application/pdf', 50, '');
    expect(result).toBe('Scanned Image');
  });

  it('detects scanned PDF when text is garbled encoding', () => {
    // Simulate garbled replacement chars from a fake text layer
    const garbled = '�'.repeat(200) + 'abc';
    const result = detectFormat('scanned.pdf', 'application/pdf', garbled.length, garbled);
    expect(result).toBe('Scanned Image');
  });

  it('detects JPG as scanned image', () => {
    const result = detectFormat('ppo_form.jpg', 'image/jpeg', 0);
    expect(result).toBe('Scanned Image');
  });

  it('detects PNG as scanned image', () => {
    const result = detectFormat('scan.png', 'image/png', 0);
    expect(result).toBe('Scanned Image');
  });

  it('detects DOCX', () => {
    const result = detectFormat('order.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1000);
    expect(result).toBe('DOCX');
  });

  it('detects CSV', () => {
    const result = detectFormat('payroll.csv', 'text/csv', 2000);
    expect(result).toBe('CSV');
  });

  it('detects TIFF as scanned image', () => {
    const result = detectFormat('scan.tiff', 'image/tiff', 0);
    expect(result).toBe('Scanned Image');
  });
});

describe('chunkText', () => {
  it('returns at least 1 chunk for non-empty text', () => {
    const text = 'a'.repeat(500);
    expect(chunkText(text)).toBeGreaterThan(0);
  });

  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(5000);
    expect(chunkText(text)).toBeGreaterThan(1);
  });

  it('returns 0 for empty text', () => {
    expect(chunkText('')).toBe(0);
  });
});
