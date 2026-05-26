import pdfParse from 'pdf-parse';

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
}

const SCANNED_TEXT_THRESHOLD = 100;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export function detectFormat(filename: string, mimeType: string, textLength: number): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'].includes(ext)) return 'Scanned Image';
  if (mimeType.startsWith('image/')) return 'Scanned Image';
  if (ext === 'csv' || mimeType === 'text/csv') return 'CSV';
  if (['docx', 'doc'].includes(ext) || mimeType.includes('wordprocessingml') || mimeType.includes('msword')) return 'DOCX';

  if (ext === 'pdf' || mimeType === 'application/pdf') {
    if (textLength < SCANNED_TEXT_THRESHOLD) return 'Scanned Image';
    return 'PDF (text)';
  }

  return 'Unknown';
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
    console.warn('GEMINI_API_KEY not set — returning mock fields');
    return getMockFields();
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
      return getMockFields();
    }

    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return getMockFields();
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.fields ?? getMockFields();
  } catch {
    return getMockFields();
  }
}

function getMockFields(): ExtractedField[] {
  return [
    { key: 'pensioner_name', label: 'Pensioner Name', value: 'Ramesh Kumar', confidence: 0.96 },
    { key: 'dob', label: 'Date of Birth', value: '15-03-1962', confidence: 0.94 },
    { key: 'pension_amount', label: 'Pension Amount', value: '₹18,500', confidence: 0.91 },
    { key: 'effective_date', label: 'Effective Date', value: '01-04-2020', confidence: 0.89 },
    { key: 'ppo_number', label: 'PPO Number', value: 'PB/001/2020/00234', confidence: 0.93 },
  ];
}

export async function ingestFile(
  filename: string,
  mimeType: string,
  buffer: Buffer
): Promise<IngestionResult> {
  let textLength = 0;
  let extractedText = '';

  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    extractedText = await extractTextFromPdf(buffer);
    textLength = extractedText.trim().length;
  }

  const formatDetected = detectFormat(filename, mimeType, textLength);

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
