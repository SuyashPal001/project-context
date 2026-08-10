import pdfParse from 'pdf-parse';
import JSZip from 'jszip';

export interface ExtractedField {
  key: string;
  label: string;
  value: string;
  confidence: number;
}

export interface IngestionResult {
  formatDetected: string;
  chunkCount: number;
  extractedFields: ExtractedField[] | null;
  /** Number of member files ingested. Only set for archive uploads. */
  memberCount?: number;
}

const SCANNED_TEXT_THRESHOLD = 100;
const GARBLED_CHAR_THRESHOLD = 0.3; // >30% suspicious chars = garbled = scanned
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

/**
 * Borrowed from RAGFlow deepdoc/parser/pdf_parser.py.
 * Checks if pdf-parse returned garbage encoding (replacement chars, zero-width chars).
 * A text PDF returning garbled chars means the PDF is actually a scanned image
 * with a fake text layer — we should route it to the vision LLM instead.
 */
function isGarbled(text: string): boolean {
  if (!text || text.length === 0) return false;
  const suspicious = text.split('').filter(c => {
    const code = c.charCodeAt(0);
    return code === 65533 || code === 0 || code === 65279 || (code >= 57344 && code <= 63743);
  }).length;
  return suspicious / text.length > GARBLED_CHAR_THRESHOLD;
}

export function detectFormat(filename: string, mimeType: string, textLength: number, extractedText?: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'].includes(ext)) return 'Scanned Image';
  if (mimeType.startsWith('image/')) return 'Scanned Image';
  if (ext === 'csv' || mimeType === 'text/csv') return 'CSV';
  if (['docx', 'doc'].includes(ext) || mimeType.includes('wordprocessingml') || mimeType.includes('msword')) return 'DOCX';

  if (ext === 'pdf' || mimeType === 'application/pdf') {
    // Text too short → scanned
    if (textLength < SCANNED_TEXT_THRESHOLD) return 'Scanned Image';
    // Text passes length check but is garbled encoding → scanned with fake text layer
    if (extractedText && isGarbled(extractedText)) return 'Scanned Image';
    return 'PDF (text)';
  }

  return 'Unknown';
}

/**
 * Archive expansion.
 *
 * A user's document corpus normally arrives as a zip. Accepting the archive and
 * unpacking it here is cheaper than asking them to upload files one at a time —
 * and the alternative we shipped first was telling them to use WeTransfer.
 *
 * Nested archives are deliberately not recursed into: one level keeps the
 * expansion bounded and there is no legitimate corpus shape that needs more.
 */

const ARCHIVE_EXTENSIONS = ['zip'];
const ARCHIVE_MIME_TYPES = ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'];

/** Extensions the downstream pipeline can actually extract text from. */
const INGESTIBLE_EXTENSIONS = ['pdf', 'docx', 'txt'];

const MAX_ARCHIVE_ENTRIES = 200;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export interface ArchiveEntry {
  filename: string;
  buffer: Buffer;
}

export function isArchive(filename: string, mimeType: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ARCHIVE_EXTENSIONS.includes(ext) || ARCHIVE_MIME_TYPES.includes(mimeType.toLowerCase());
}

/** Resource forks, dotfiles and directory markers carry no ingestible content. */
function isJunkEntry(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return path.startsWith('__MACOSX/') || base.startsWith('.') || base === '';
}

export async function expandArchive(buffer: Buffer): Promise<ArchiveEntry[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('The archive could not be read. It may be corrupt or password protected.');
  }

  const files = Object.values(zip.files).filter(f => !f.dir);

  if (files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `The archive contains too many files (${files.length}). The limit is ${MAX_ARCHIVE_ENTRIES} per upload.`
    );
  }

  const entries: ArchiveEntry[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (isJunkEntry(file.name)) continue;

    const filename = file.name.split('/').pop() as string;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (!INGESTIBLE_EXTENSIONS.includes(ext)) continue;

    // Trust the declared uncompressed size when the reader exposes it, so a zip
    // bomb is rejected before it is decompressed into memory.
    const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof declared === 'number' && totalBytes + declared > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `The archive contents are too large once unpacked. The limit is ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)}MB.`
      );
    }

    const content = await file.async('nodebuffer');
    totalBytes += content.length;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `The archive contents are too large once unpacked. The limit is ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)}MB.`
      );
    }

    entries.push({ filename, buffer: content });
  }

  return entries;
}

export function chunkText(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  if (text.length <= CHUNK_SIZE) return 1;
  let count = 0;
  let i = 0;
  while (i < text.length) {
    count++;
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return count;
}

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    return '';
  }
}

export async function extractFieldsWithGemini(
  imageBuffer: Buffer,
  mimeType: string
): Promise<ExtractedField[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping field extraction');
    return [];
  }

  const base64Image = imageBuffer.toString('base64');
  const safeMime = mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

  const prompt = `You are extracting structured data from an Indian government pension document.
Extract all visible fields and return ONLY valid JSON in this exact format:
{
  "fields": [
    {"key": "pensioner_name", "label": "Pensioner Name", "value": "...", "confidence": 0.95},
    {"key": "dob", "label": "Date of Birth", "value": "...", "confidence": 0.92},
    {"key": "pension_amount", "label": "Pension Amount", "value": "...", "confidence": 0.89},
    {"key": "effective_date", "label": "Effective Date", "value": "...", "confidence": 0.91},
    {"key": "ppo_number", "label": "PPO Number", "value": "...", "confidence": 0.94}
  ]
}
Only include fields actually visible in the document. Confidence between 0.0 and 1.0.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: safeMime, data: base64Image } },
            { text: prompt }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
        })
      }
    );

    if (!response.ok) {
      console.error('Gemini API error:', response.status);
      return [];
    }

    const result = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.fields ?? [];
  } catch {
    return [];
  }
}

export async function ingestFile(
  filename: string,
  mimeType: string,
  buffer: Buffer
): Promise<IngestionResult> {
  if (isArchive(filename, mimeType)) {
    const entries = await expandArchive(buffer);
    if (entries.length === 0) {
      throw new Error(
        `The archive contains no supported documents. Supported types are ${INGESTIBLE_EXTENSIONS.map(e => `.${e}`).join(', ')}.`
      );
    }

    let chunkCount = 0;
    for (const entry of entries) {
      const member = await ingestFile(entry.filename, '', entry.buffer);
      chunkCount += member.chunkCount;
    }

    return {
      formatDetected: 'Archive (zip)',
      chunkCount,
      extractedFields: null,
      memberCount: entries.length,
    };
  }

  let textLength = 0;
  let extractedText = '';

  if (mimeType === 'text/plain' || filename.toLowerCase().endsWith('.txt')) {
    const text = buffer.toString('utf8');
    return { formatDetected: 'Text', chunkCount: chunkText(text), extractedFields: null };
  }

  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    extractedText = await extractTextFromPdf(buffer);
    textLength = extractedText.trim().length;
  }

  const formatDetected = detectFormat(filename, mimeType, textLength, extractedText);

  if (formatDetected === 'Scanned Image') {
    const extractedFields = await extractFieldsWithGemini(buffer, mimeType);
    const ocrText = extractedFields.map(f => `${f.label}: ${f.value}`).join('\n');
    const chunkCount = Math.max(chunkText(ocrText), 8);
    return { formatDetected, chunkCount, extractedFields };
  }

  if (formatDetected === 'PDF (text)') {
    return { formatDetected, chunkCount: chunkText(extractedText), extractedFields: null };
  }

  const simulatedChunks = Math.max(Math.floor(buffer.length / 800), 4);
  return { formatDetected, chunkCount: simulatedChunks, extractedFields: null };
}
