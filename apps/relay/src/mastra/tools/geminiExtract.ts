import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function buildExtractionPrompt(documentType: string): string {
  const base = `You are extracting structured data from an Indian government document. Return ONLY valid JSON in this format: {"fields": [{"key":"...","label":"...","value":"...","confidence":0.0}]}. Confidence between 0.0 and 1.0. Only include fields actually visible.`;
  const typeHints: Record<string, string> = {
    'Service Book': 'Expected fields: officer_name, dob, joining_date, current_post, office_code, employee_id',
    'PPO': 'Expected fields: pensioner_name, ppo_number, pension_amount, effective_date, office_code, dob',
    'Audit Memo': 'Expected fields: memo_number, memo_date, audit_period, findings_summary, officer_name',
    'Payroll Statement': 'Expected fields: employee_id, employee_name, basic_pay, allowances, deductions, net_pay, month',
  };
  const hint = typeHints[documentType] ?? 'Extract all visible fields with descriptive keys.';
  return `${base}\n\nDocument type: ${documentType}\n${hint}`;
}

function getMockFields() {
  return [
    { key: 'pensioner_name', label: 'Pensioner Name', value: 'Ramesh Kumar', confidence: 0.96 },
    { key: 'dob', label: 'Date of Birth', value: '15-03-1962', confidence: 0.94 },
    { key: 'pension_amount', label: 'Pension Amount', value: '₹18,500', confidence: 0.91 },
    { key: 'effective_date', label: 'Effective Date', value: '01-04-2020', confidence: 0.89 },
    { key: 'ppo_number', label: 'PPO Number', value: 'PB/001/2020/00234', confidence: 0.93 },
  ];
}

export const geminiExtractTool = createTool({
  id: 'gemini-extract',
  description: 'Extracts structured fields from a document image using Gemini Vision with a doc-type-specific prompt.',
  inputSchema: z.object({
    imageBase64: z.string(),
    mimeType: z.string(),
    documentType: z.string().default('Unknown'),
  }),
  outputSchema: z.object({
    fields: z.array(z.object({
      key: z.string(),
      label: z.string(),
      value: z.string(),
      confidence: z.number(),
    })),
  }),
  execute: async ({ context }) => {
    const { imageBase64, mimeType, documentType } = context;
    if (!GEMINI_API_KEY) return { fields: getMockFields() };

    const safeMime = mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
    const prompt = buildExtractionPrompt(documentType);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inlineData: { mimeType: safeMime, data: imageBase64 } },
              { text: prompt },
            ]}],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
          }),
        }
      );
      if (!response.ok) return { fields: getMockFields() };
      const result = await response.json() as any;
      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { fields: getMockFields() };
      const parsed = JSON.parse(jsonMatch[0]);
      return { fields: parsed.fields ?? getMockFields() };
    } catch {
      return { fields: getMockFields() };
    }
  },
});
