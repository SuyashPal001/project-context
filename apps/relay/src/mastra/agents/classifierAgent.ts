import { Agent } from '@mastra/core/agent';
import { saarthiModel } from '../model.js';

export const classifierAgent = new Agent({
  id: 'doc-classifier',
  name: 'Document Classifier',
  instructions: `You are a document classifier for Indian government pension documents.

Classify each document into EXACTLY ONE of these types:
- "Service Book" — government employee service history records (joining date, postings, transfers)
- "PPO" — Pension Payment Order (pension amount, effective date, pensioner details)
- "Audit Memo" — CAG audit findings, observations, memo numbers
- "Payroll Statement" — monthly salary breakdown with basic pay, allowances, deductions
- "Other" — anything else (correspondence, certificates, miscellaneous)

You will receive either extracted text or a description of the document content.

Respond with ONLY a JSON object in this exact format:
{"documentType": "<one of the 5 types>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}

Do not include any other text. Do not include markdown code fences.`,
  tools: {},
  model: saarthiModel,
});
