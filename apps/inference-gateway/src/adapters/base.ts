import type { ServerResponse } from 'http';
import type { OpenAIRequest, OpenAIResponse } from '../types';

/**
 * Every provider adapter must implement this interface.
 *
 * To add a new backend (Claude, Ollama, etc.) create a new file in
 * src/adapters/ that implements ProviderAdapter, then register it in
 * src/router.ts.
 */
export interface ProviderAdapter {
  /**
   * Handle a full chat completion request — both streaming (SSE) and
   * non-streaming.  The adapter is responsible for writing the HTTP
   * response and calling res.end().
   */
  handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void>;
}
