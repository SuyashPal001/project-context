import { Agent } from '@mastra/core/agent'
import { saarthiModel } from '../model.js'
import { tenantContextSchema } from '../context.js'

// ---------------------------------------------------------------------------
// DocumentIntelligenceAgent — Tier 3 of the AI-PARAS multi-agent network.
//
// Specialist: reads Service Book / PPO text+OCR → structured pension field set
// with page provenance. Genuine LLM reasoning for the extraction step.
//
// The deterministic key-map fallback (extractPensionFieldsFromRaw) is used
// when the agent is unavailable or returns an unparseable response.
// ---------------------------------------------------------------------------

// Deterministic fallback: maps raw ingestion keys → pension field set.
// Used by aiParasAgent's extract_pension_fields tool when agent call fails.
export function extractPensionFieldsFromRaw(
  rawFields: Array<{ key: string; label: string; value: string; confidence: number; page?: number }>
): Record<string, { value: number | null; sourcePage: number | null; sourceDoc: string }> {
  const KEY_MAP: Record<string, string> = {
    pension_amount: 'declared_pension',
    ppo_pension:    'declared_pension',
    basic_pay:      'last_pay',
    last_pay:       'last_pay',
    qualifying_service: 'qualifying_service_years',
    service_years:  'qualifying_service_years',
    commutation:    'commutation_amount',
    commutation_amount: 'commutation_amount',
    dcrg:           'declared_dcrg',
    gratuity:       'declared_dcrg',
  }

  const result: Record<string, { value: number | null; sourcePage: number | null; sourceDoc: string }> = {}

  for (const f of rawFields) {
    const pensionKey = KEY_MAP[f.key.toLowerCase()] ?? KEY_MAP[
      Object.keys(KEY_MAP).find(k => f.key.toLowerCase().includes(k)) ?? ''
    ]
    if (!pensionKey) continue
    const numeric = parseFloat(f.value.replace(/[₹,\s]/g, ''))
    result[pensionKey] = {
      value: isNaN(numeric) ? null : numeric,
      sourcePage: f.page ?? null,
      sourceDoc: f.label ?? f.key,
    }
  }

  return result
}

export const documentIntelligenceAgent = new Agent({
  id: 'document-intelligence',
  name: 'Document Intelligence',
  description: 'Extracts structured pension fields from government document text/OCR with page provenance. Called by AI-PARAS for the document reading step.',

  instructions: `You are a document intelligence specialist for Indian government pension documents.

Given the text content of a pension document, extract these specific pension fields:
- last_pay: Basic pay at retirement (numeric value, in rupees)
- qualifying_service_years: Total qualifying service (numeric, decimal years, e.g. 28.5)
- declared_pension: Pension amount claimed (numeric, in rupees)
- commutation_amount: Commutation amount (numeric, in rupees; 0 if no commutation)
- declared_dcrg: Death-cum-retirement gratuity amount claimed (numeric, in rupees)

For each field, note the page number where the value appears in the source document.

Return ONLY valid JSON in this exact format:
{
  "fields": {
    "last_pay": { "value": 54360, "sourcePage": 4, "sourceDoc": "Service Book" },
    "qualifying_service_years": { "value": 28.5, "sourcePage": 2, "sourceDoc": "Service Book" },
    "declared_pension": { "value": 23400, "sourcePage": 1, "sourceDoc": "PPO Form" },
    "commutation_amount": { "value": 0, "sourcePage": 1, "sourceDoc": "PPO Form" },
    "declared_dcrg": { "value": 500000, "sourcePage": 3, "sourceDoc": "Service Book" }
  },
  "ppo_number": "PPO/PB/2019/00847"
}

Rules:
- Never guess or approximate — only include values explicitly stated in the document
- If a field is not found, omit it from "fields"
- Values must be numeric (no currency symbols)
- qualifying_service_years should be in decimal years (e.g. 28 years 6 months = 28.5)`,

  model: saarthiModel,
  requestContextSchema: tenantContextSchema,
})
