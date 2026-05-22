/**
 * Ollama adapter — local model backend (qwen3, llama3, mistral, etc.)
 *
 * Ollama exposes an OpenAI-compatible API at /v1/chat/completions,
 * so no format translation is needed. The only job here is:
 *   1. Strip the "ollama/" routing prefix from the model name
 *   2. Forward the request to Ollama at OLLAMA_URL
 *   3. Pipe the response back (streaming or JSON) — no transformation
 */

import type { ServerResponse } from 'http';
import type { ProviderAdapter } from './base';
import { AdapterError } from './base';
import type { OpenAIRequest } from '../types';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export class OllamaAdapter implements ProviderAdapter {
  async handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void> {
    // Strip "ollama/" prefix if present; for fallback requests (non-ollama/* model),
    // use the configured local fallback model instead of forwarding the original name.
    const raw = req.model ?? '';
    const model = raw.startsWith('ollama/')
      ? raw.replace(/^ollama\//, '')
      : (process.env.OLLAMA_FALLBACK_MODEL ?? 'qwen3.5:4b');

    console.log(
      `[ollama-adapter] model=${model} messages=${req.messages.length} stream=${req.stream ?? false}`,
    );

    let ollamaRes: Response;
    try {
      // think: false disables qwen3.5 reasoning chain — required for non-GPU inference
      ollamaRes = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, model, think: false }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ollama-adapter] connection error: ${message}`);
      throw new AdapterError(502, `Ollama unreachable: ${message}`);
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      console.error(`[ollama-adapter] error ${ollamaRes.status}: ${errText}`);
      throw new AdapterError(ollamaRes.status, errText);
    }

    if (req.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Pipe SSE chunks through directly — Ollama /v1/ uses same SSE format as OpenAI
      const reader = ollamaRes.body!.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        res.end();
      }

      console.log(`[ollama-adapter] stream done model=${model}`);
    } else {
      const json = await ollamaRes.json();
      console.log(
        `[ollama-adapter] done model=${model}` +
        ` textLen=${(json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content?.length ?? 0}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    }
  }
}
