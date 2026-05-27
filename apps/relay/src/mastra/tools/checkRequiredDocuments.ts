import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const REQUIRED_DOCS = ['service_book', 'ppo_form', 'salary_certificate'] as const;

export function checkRequiredDocuments(presentDocs: string[]): { complete: boolean; missing: string[] } {
  const missing = REQUIRED_DOCS.filter(d => !presentDocs.includes(d));
  return { complete: missing.length === 0, missing };
}

export const checkRequiredDocumentsTool = createTool({
  id: 'check-required-documents',
  description: 'Checks whether a pension case has all required document types (service book, PPO form, salary certificate).',
  inputSchema: z.object({ presentDocs: z.array(z.string()) }),
  outputSchema: z.object({ complete: z.boolean(), missing: z.array(z.string()) }),
  execute: async (inputData) => checkRequiredDocuments(inputData.presentDocs),
});
