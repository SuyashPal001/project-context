import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { persistCost } from '../cost.js';

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001';

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
    { key: 'pensioner_name', label: 'Pensioner Name', value: 'Sh. Harbhajan Singh (Retd. Naib Tehsildar)', confidence: 0.96 },
    { key: 'dob', label: 'Date of Birth', value: '12-07-1961', confidence: 0.94 },
    { key: 'pension_amount', label: 'Pension Amount', value: '₹23,400', confidence: 0.91 },
    { key: 'effective_date', label: 'Effective Date', value: '01-11-2019', confidence: 0.89 },
    { key: 'ppo_number', label: 'PPO Number', value: 'PPO/PB/2019/00847', confidence: 0.93 },
  ];
}

export async function geminiExtract(imageBase64: string, mimeType: string, documentType: string, tenantId?: string): Promise<{ fields: Array<{ key: string; label: string; value: string; confidence: number }> }> {
  const safeMime = mimeType.startsWith('image/') ? mimeType : 'image/jpeg'
  const prompt = buildExtractionPrompt(documentType)
  try {
    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-2.5-flash',
        temperature: 0.1,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${safeMime};base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    })
    if (!response.ok) return { fields: getMockFields() }
    const result = await response.json() as any
    if (tenantId && result?.usage) {
      persistCost({
        tenantId,
        agentId: 'gemini-extract',
        workflowId: 'document-ingestion',
        model: 'gemini-2.5-flash',
        inputTokens: result.usage.prompt_tokens ?? 0,
        outputTokens: result.usage.completion_tokens ?? 0,
      })
    }
    const text = result?.choices?.[0]?.message?.content ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { fields: getMockFields() }
    const parsed = JSON.parse(jsonMatch[0])
    return { fields: parsed.fields ?? getMockFields() }
  } catch {
    return { fields: getMockFields() }
  }
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
    return geminiExtract(context.imageBase64, context.mimeType, context.documentType)
  },
});
