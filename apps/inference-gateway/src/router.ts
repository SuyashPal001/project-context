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

  // Default: Vertex AI / Gemini model backend
  return vertexAdapter;
}
