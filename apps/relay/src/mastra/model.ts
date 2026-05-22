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
export const saarthiLiteModel = google(process.env.MASTRA_LITE_MODEL ?? 'gemini-2.5-flash-lite')

// Private-only model for restricted data (CASA/KYC).
// Routes to OllamaAdapter in the inference gateway — never leaves bank infrastructure.
export const saarthiPrivateModel = google(process.env.MASTRA_PRIVATE_MODEL ?? 'ollama/llama3.2')
