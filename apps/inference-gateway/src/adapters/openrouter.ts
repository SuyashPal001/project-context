/**
 * OpenRouter adapter — cloud model backend, routed via the "openrouter/" model prefix.
 *
 * OpenRouter's API is itself OpenAI-compatible, so unlike AnthropicAdapter this is a
 * thin passthrough (same shape as OllamaAdapter) rather than a request/response
 * translator: strip the gateway's "openrouter/" routing prefix, forward everything
 * else as-is to OpenRouter, pipe the response straight back.
 *
 * No fallback chain for this adapter (see router.ts) — the user explicitly picked this
 * model via the chat UI's model picker, so silently answering with a different model
 * on failure would be worse than a visible error.
 */

import type { ServerResponse } from 'http';
import type { ProviderAdapter } from './base';
import { AdapterError } from './base';
import type { OpenAIRequest } from '../types';
import { latency } from '../metrics.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterAdapter implements ProviderAdapter {
  async handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new AdapterError(503, 'openrouter_not_configured');
    }

    const model = (req.model ?? '').replace(/^openrouter\//, '');

    console.log(
      `[openrouter-adapter] model=${model} messages=${req.messages.length} stream=${req.stream ?? false}`,
    );

    let openRouterRes: Response;
    try {
      openRouterRes = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          // Recommended by OpenRouter — attributes usage to this app on their dashboard.
          'HTTP-Referer': 'https://projectcontext.co',
          'X-Title': 'project-context',
        },
        body: JSON.stringify({ ...req, model }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[openrouter-adapter] connection error: ${message}`);
      throw new AdapterError(502, `OpenRouter unreachable: ${message}`);
    }

    if (!openRouterRes.ok) {
      const errText = await openRouterRes.text();
      console.error(`[openrouter-adapter] error ${openRouterRes.status}: ${errText}`);
      throw new AdapterError(openRouterRes.status, errText);
    }

    if (req.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const reader = openRouterRes.body!.getReader();
      const decoder = new TextDecoder();
      const t0 = Date.now();
      let ttftFired = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ttftFired) {
            latency.observe({ adapter: 'openrouter', metric: 'ttft' }, Date.now() - t0);
            ttftFired = true;
          }
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        res.end();
      }
      console.log(`[openrouter-adapter] stream done model=${model}`);
    } else {
      const json = await openRouterRes.json();
      console.log(`[openrouter-adapter] done model=${model}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    }
  }
}
