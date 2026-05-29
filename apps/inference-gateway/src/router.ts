/**
 * Inference Gateway router — selects the right adapter based on the requested model.
 *
 * Routing rules (first match wins):
 *   claude-*    → AnthropicAdapter  (Anthropic model backend)
 *   gemini-*    → VertexAdapter     (GCP Vertex AI model backend)
 *   ollama/*    → OllamaAdapter     (local model backend — add OllamaAdapter to enable)
 *   (default)   → VertexAdapter
 */

import type { ProviderAdapter } from './adapters/base';
import { VertexAdapter } from './adapters/vertex';
import { AnthropicAdapter } from './adapters/anthropic';
import { OllamaAdapter } from './adapters/ollama';
import { CircuitBreaker, CircuitBreakerAdapter } from './circuit-breaker';

const vertexAdapter    = new VertexAdapter();
const anthropicAdapter = new AnthropicAdapter();
const ollamaAdapter    = new OllamaAdapter();

export const vertexBreaker    = new CircuitBreaker('vertex',    { failureThreshold: 10, resetTimeoutMs: 60_000 });
export const anthropicBreaker = new CircuitBreaker('anthropic', { failureThreshold: 3, resetTimeoutMs: 60_000 });
export const ollamaBreaker    = new CircuitBreaker('ollama',    { failureThreshold: 5, resetTimeoutMs: 30_000 });

const vertexCB    = new CircuitBreakerAdapter(vertexAdapter,    vertexBreaker);
const anthropicCB = new CircuitBreakerAdapter(anthropicAdapter, anthropicBreaker);
const ollamaCB    = new CircuitBreakerAdapter(ollamaAdapter,    ollamaBreaker);

/**
 * Returns an ordered fallback chain for the requested model.
 * The handler tries each adapter in sequence — moving to the next only if
 * the current one throws (AdapterError or any error) before headers are sent.
 *
 * Fallback order:
 *   gemini-*   → Vertex AI → Anthropic → Ollama (local, always available)
 *   claude-*   → Anthropic → Ollama
 *   ollama/*   → Ollama only (local — nowhere to fall back to)
 */
export function getAdapterChain(model: string | undefined): ProviderAdapter[] {
  const m = model ?? '';
  if (m.startsWith('claude'))  return [anthropicCB, ollamaCB];
  if (m.startsWith('ollama/')) return [ollamaCB];
  return [vertexCB, anthropicCB, ollamaCB];
}

/**
 * Private-only chain — used when X-Data-Classification: restricted is set.
 * Restricted data (CASA/KYC) must never be sent to cloud providers.
 */
export function getPrivateOnlyChain(): ProviderAdapter[] {
  return [ollamaCB];
}
