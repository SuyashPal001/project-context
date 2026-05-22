// Isolated model definition — imported by both index.ts and taskExecution.ts.
// Keeping it here breaks the circular TDZ issue: saarthiModel must be available
// at module init time in taskExecution.ts (for scorer creation), but the
// index.ts → taskExecution.ts → index.ts circular dep causes a TDZ error when
// the model is defined in index.ts.
//
// Uses @ai-sdk/google (AI SDK connector) pointed at the local Inference Gateway (port 4001).
// The gateway handles Vertex AI auth via service account key and routes to the right model backend.

import { createGoogleGenerativeAI } from '@ai-sdk/google'

const google = createGoogleGenerativeAI({
  baseURL: (process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001') + '/v1',
  apiKey: process.env.GEMINI_API_KEY ?? 'placeholder',
})

export const saarthiModel = google(process.env.MASTRA_MODEL ?? 'gemini-2.5-flash')

// Lightweight model for conversational turns (thinkingBudget === 0).
// Cuts LLM span from ~5.8s to ~1-2s on simple messages.
export const saarthiLiteModel = google(process.env.MASTRA_LITE_MODEL ?? 'gemini-2.5-flash-lite')
