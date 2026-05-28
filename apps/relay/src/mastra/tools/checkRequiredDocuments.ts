import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const REQUIRED_DOCS = ['service_book', 'ppo_form', 'salary_certificate'] as const;

const KEYWORDS: Record<string, string[]> = {
  service_book:       ['service', 'book', 'sb'],
  ppo_form:           ['ppo', 'pension payment order', 'payment order', 'payment', 'payement', 'form'],
  salary_certificate: ['salary', 'pay', 'certificate', 'cert', 'disbursement'],
}

export function checkRequiredDocuments(presentDocs: string[]): { complete: boolean; missing: string[] } {
  const lower = presentDocs.map(d => d.toLowerCase())
  const missing = REQUIRED_DOCS.filter(req =>
    !lower.some(name => KEYWORDS[req].some(kw => name.includes(kw)))
  )
  return { complete: missing.length === 0, missing };
}

export const checkRequiredDocumentsTool = createTool({
  id: 'check-required-documents',
  description: 'Checks whether a pension case has all required document types (service book, PPO form, salary certificate).',
  inputSchema: z.object({ presentDocs: z.array(z.string()) }),
  outputSchema: z.object({ complete: z.boolean(), missing: z.array(z.string()) }),
  execute: async (inputData) => checkRequiredDocuments(inputData.presentDocs),
});
