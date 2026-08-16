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
  apiKey: process.env.INTERNAL_SERVICE_KEY ?? '',
})

// Private gateway instance — adds x-data-classification: restricted header.
// The inference gateway routes these to OllamaAdapter only (never leaves bank infra).
const gatewayPrivate = createOpenAICompatible({
  name: 'inference-gateway-private',
  baseURL: gatewayUrl,
  apiKey: process.env.INTERNAL_SERVICE_KEY ?? '',
  headers: { 'x-data-classification': 'restricted' },
})

export const platformModel = gateway(process.env.MASTRA_MODEL ?? 'gemini-2.5-flash')

// Lightweight model for conversational turns (thinkingBudget === 0).
export const liteModel = gateway(process.env.MASTRA_LITE_MODEL ?? 'gemini-2.5-flash-lite')

// Private-only model for restricted data (CASA/KYC).
// x-data-classification header forces OllamaAdapter — never hits cloud providers.
export const privateModel = gatewayPrivate(process.env.MASTRA_PRIVATE_MODEL ?? 'ollama/llama3.2')

// Builds a model connector from an arbitrary model string at request time — used
// when a user has picked a specific model via the chat UI's model picker, rather
// than one of the three module-level constants above.
export function resolveModel(modelString: string) {
  return gateway(modelString)
}

// Maps an llm_providers row's {provider, model} into the model-string convention
// router.ts dispatches on (see apps/inference-gateway/src/router.ts). Returns null
// for providers the gateway doesn't route yet (openai, mistral, kimi) so callers can
// fall through to default model selection instead of sending a string nothing handles.
export function buildGatewayModelString(provider: string, model: string): string | null {
  if (provider === 'openrouter') return `openrouter/${model}`
  if (provider === 'anthropic' || provider === 'vertex') return model
  return null
}
