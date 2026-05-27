import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const GARBLED_CHAR_THRESHOLD = 0.3;
const SCANNED_TEXT_THRESHOLD = 100;

function isGarbled(text: string): boolean {
  if (!text || text.length === 0) return false;
  const suspicious = text.split('').filter(c => {
    const code = c.charCodeAt(0);
    return code === 65533 || code === 0 || code === 65279 || (code >= 57344 && code <= 63743);
  }).length;
  return suspicious / text.length > GARBLED_CHAR_THRESHOLD;
}

export const detectFormatTool = createTool({
  id: 'detect-format',
  description: 'Detects document format from filename, MIME type, and optional extracted text.',
  inputSchema: z.object({
    filename: z.string(),
    mimeType: z.string(),
    textLength: z.number().default(0),
    extractedText: z.string().optional(),
  }),
  outputSchema: z.object({
    formatDetected: z.string(),
    isScanned: z.boolean(),
  }),
  execute: async ({ context }) => {
    const { filename, mimeType, textLength, extractedText } = context;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    if (['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'].includes(ext)) return { formatDetected: 'Scanned Image', isScanned: true };
    if (mimeType.startsWith('image/')) return { formatDetected: 'Scanned Image', isScanned: true };
    if (ext === 'csv' || mimeType === 'text/csv') return { formatDetected: 'CSV', isScanned: false };
    if (['docx', 'doc'].includes(ext) || mimeType.includes('wordprocessingml')) return { formatDetected: 'DOCX', isScanned: false };

    if (ext === 'pdf' || mimeType === 'application/pdf') {
      if (textLength < SCANNED_TEXT_THRESHOLD) return { formatDetected: 'Scanned Image', isScanned: true };
      if (extractedText && isGarbled(extractedText)) return { formatDetected: 'Scanned Image', isScanned: true };
      return { formatDetected: 'PDF (text)', isScanned: false };
    }
    return { formatDetected: 'Unknown', isScanned: false };
  },
});
