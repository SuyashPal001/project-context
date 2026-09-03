/**
 * Inference Gateway router — selects the right adapter based on the requested model.
 *
 * Routing rules (first match wins):
 *   openrouter/* → OpenRouterAdapter  (cloud model backend, no fallback)
 *   claude-*    → AnthropicAdapter  (Anthropic model backend)
 *   gemini-*    → VertexAdapter (ADC) → GeminiAdapter (API key) → Ollama
 *   ollama/*    → OllamaAdapter     (local model backend)
 *   (default)   → VertexAdapter → GeminiAdapter → Ollama
 */

import type { ProviderAdapter } from './adapters/base';
import { VertexAdapter } from './adapters/vertex';
import { AnthropicAdapter } from './adapters/anthropic';
import { OllamaAdapter } from './adapters/ollama';
import { GeminiAdapter } from './adapters/gemini';
import { OpenRouterAdapter } from './adapters/openrouter';
import { CircuitBreaker, CircuitBreakerAdapter } from './circuit-breaker';

const vertexAdapter     = new VertexAdapter();
const anthropicAdapter  = new AnthropicAdapter();
const ollamaAdapter     = new OllamaAdapter();
const geminiAdapter     = new GeminiAdapter();
const openrouterAdapter = new OpenRouterAdapter();

export const vertexBreaker     = new CircuitBreaker('vertex',     { failureThreshold: 10, resetTimeoutMs: 60_000 });
export const anthropicBreaker  = new CircuitBreaker('anthropic',  { failureThreshold: 3, resetTimeoutMs: 60_000 });
export const ollamaBreaker     = new CircuitBreaker('ollama',     { failureThreshold: 5, resetTimeoutMs: 30_000 });
export const geminiBreaker     = new CircuitBreaker('gemini',     { failureThreshold: 5, resetTimeoutMs: 60_000 });
export const openrouterBreaker = new CircuitBreaker('openrouter', { failureThreshold: 5, resetTimeoutMs: 60_000 });

// Separate breakers for image generation (apps/inference-gateway/src/images.ts) — a
// preview-tier model with a different failure profile than chat completions. Sharing
// vertexBreaker/geminiBreaker with chat would let image-generation failures open the
// chat-side breaker (and vice versa), degrading unrelated traffic.
export const vertexImageBreaker = new CircuitBreaker('vertex-image', { failureThreshold: 10, resetTimeoutMs: 60_000 });
export const geminiImageBreaker = new CircuitBreaker('gemini-image', { failureThreshold: 5, resetTimeoutMs: 60_000 });

// Music generation breaker for lyria-002 (apps/inference-gateway/src/music.ts) — no
// Gemini-API-key fallback available. Isolated from chat/image breakers to prevent
// unrelated traffic degradation.
export const vertexMusicBreaker = new CircuitBreaker('vertex-music', { failureThreshold: 10, resetTimeoutMs: 60_000 });

const vertexCB     = new CircuitBreakerAdapter(vertexAdapter,     vertexBreaker);
const anthropicCB  = new CircuitBreakerAdapter(anthropicAdapter,  anthropicBreaker);
const ollamaCB     = new CircuitBreakerAdapter(ollamaAdapter,     ollamaBreaker);
const geminiCB     = new CircuitBreakerAdapter(geminiAdapter,     geminiBreaker);
const openrouterCB = new CircuitBreakerAdapter(openrouterAdapter, openrouterBreaker);

/**
 * Returns an ordered fallback chain for the requested model.
 * The handler tries each adapter in sequence — moving to the next only if
 * the current one throws (AdapterError or any error) before headers are sent.
 *
 * Fallback order:
 *   openrouter/* → OpenRouter only (user explicitly picked this model — no silent substitution)
 *   gemini-*     → Vertex AI (ADC) → Gemini API key → Ollama
 *   claude-*     → Anthropic → Ollama
 *   ollama/*     → Ollama only (local — nowhere to fall back to)
 */
export function getAdapterChain(model: string | undefined): ProviderAdapter[] {
  const m = model ?? '';
  if (m.startsWith('openrouter/')) return [openrouterCB];
  if (m.startsWith('claude'))  return [anthropicCB, ollamaCB];
  if (m.startsWith('ollama/')) return [ollamaCB];
  // Gemini models: Vertex AI (ADC) first, then direct Gemini API key, then Ollama
  const chain: ProviderAdapter[] = [vertexCB];
  if (geminiAdapter.isAvailable()) chain.push(geminiCB);
  chain.push(ollamaCB);
  return chain;
}

/**
 * Private-only chain — used when X-Data-Classification: restricted is set.
 * Restricted data (CASA/KYC) must never be sent to cloud providers.
 */
export function getPrivateOnlyChain(): ProviderAdapter[] {
  return [ollamaCB];
}
