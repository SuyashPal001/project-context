// Isolated model definition — imported by both index.ts and taskExecution.ts.
// Keeping it here breaks the circular TDZ issue: platformModel must be available
// at module init time in taskExecution.ts (for scorer creation), but the
// index.ts → taskExecution.ts → index.ts circular dep causes a TDZ error when
// the model is defined in index.ts.
//
// Uses @ai-sdk/openai-compatible pointed at the local Inference Gateway (port 4001).
// All requests flow through the full adapter chain (circuit breakers, fallbacks).
// The gateway translates OpenAI format → Gemini/Anthropic/Ollama as needed.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const gatewayUrl = (process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001') + '/v1'

const gateway = createOpenAICompatible({
  name: 'inference-gateway',
  baseURL: gatewayUrl,
  apiKey: 'placeholder',
})

// Private gateway instance — adds x-data-classification: restricted header.
// The inference gateway routes these to OllamaAdapter only (never leaves bank infra).
const gatewayPrivate = createOpenAICompatible({
  name: 'inference-gateway-private',
  baseURL: gatewayUrl,
  apiKey: 'placeholder',
  headers: { 'x-data-classification': 'restricted' },
})

export const platformModel = gateway(process.env.MASTRA_MODEL ?? 'gemini-2.5-flash')

// Lightweight model for conversational turns (thinkingBudget === 0).
export const liteModel = gateway(process.env.MASTRA_LITE_MODEL ?? 'gemini-2.5-flash-lite')

// Private-only model for restricted data (CASA/KYC).
// x-data-classification header forces OllamaAdapter — never hits cloud providers.
export const privateModel = gatewayPrivate(process.env.MASTRA_PRIVATE_MODEL ?? 'ollama/llama3.2')
