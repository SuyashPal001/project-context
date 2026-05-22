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
import type { OpenAIRequest } from '../types';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export class OllamaAdapter implements ProviderAdapter {
  async handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void> {
    // Strip "ollama/" prefix — used by router for dispatch, unknown to Ollama
    const model = (req.model ?? 'qwen3:14b').replace(/^ollama\//, '');

    console.log(
      `[ollama-adapter] model=${model} messages=${req.messages.length} stream=${req.stream ?? false}`,
    );

    let ollamaRes: Response;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, model }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ollama-adapter] connection error: ${message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Ollama unreachable: ${message}` } }));
      return;
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      console.error(`[ollama-adapter] error ${ollamaRes.status}: ${errText}`);
      res.writeHead(ollamaRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: errText } }));
      return;
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
