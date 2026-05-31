import type { ServerResponse } from 'http';
import type { OpenAIRequest, OpenAIResponse } from '../types';

export interface ProviderAdapter {
  handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void>;
}

/**
 * Thrown by adapters on recoverable backend failures (5xx, connection errors).
 * The fallback chain in index.ts catches this and tries the next adapter,
 * provided headers have not yet been sent.
 */
export class AdapterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
