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

const vertexAdapter = new VertexAdapter();
const anthropicAdapter = new AnthropicAdapter();
const ollamaAdapter = new OllamaAdapter();

export function getAdapter(model: string | undefined): ProviderAdapter {
  const m = model ?? '';
  if (m.startsWith('claude')) return anthropicAdapter;
  if (m.startsWith('ollama/')) return ollamaAdapter;
  return vertexAdapter;
}

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
  if (m.startsWith('claude'))  return [anthropicAdapter, ollamaAdapter];
  if (m.startsWith('ollama/')) return [ollamaAdapter];
  return [vertexAdapter, anthropicAdapter, ollamaAdapter];
}
