/**
 * Ollama/vLLM adapter — local model backend (Qwen3, llama3, mistral, etc.)
 *
 * Forwards to any OpenAI-compatible local inference server at OLLAMA_URL.
 * Currently pointed at vLLM serving Qwen3-8B on the inference-gpu VM.
 *
 * Responsibilities:
 *   1. Strip the "ollama/" routing prefix from the model name
 *   2. Forward the request to OLLAMA_URL
 *   3. Strip <think>...</think> blocks from responses (Qwen3 thinking mode)
 *   4. Pipe the response back — no other transformation
 */

import type { ServerResponse } from 'http';
import type { ProviderAdapter } from './base';
import { AdapterError } from './base';
import type { OpenAIRequest } from '../types';
import { latency } from '../metrics.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// Strip <think>...</think> blocks that Qwen3 emits when thinking mode is active.
// vLLM 0.22.0 does not support per-request thinking disable via chat_template_kwargs.
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
}

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
        body: JSON.stringify({ ...req, model, think: false, chat_template_kwargs: { enable_thinking: false } }),
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

      // Pipe SSE chunks — strip <think> blocks that may span multiple chunks.
      const reader = ollamaRes.body!.getReader();
      const decoder = new TextDecoder();
      const t0 = Date.now();
      let ttftFired = false;
      let thinkBuf = '';   // accumulates content inside <think>...</think>
      let inThink = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const raw = decoder.decode(value, { stream: true });

          // Parse each SSE line and strip think content from delta
          const lines = raw.split('\n');
          let out = '';
          for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') {
              out += line + '\n';
              continue;
            }
            try {
              const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                thinkBuf += delta.content;
                const cleaned = stripThinkTags(thinkBuf);
                if (cleaned !== thinkBuf) thinkBuf = '';
                delta.content = cleaned.replace(thinkBuf, '').trimStart();
                thinkBuf = cleaned ? '' : thinkBuf;
              }
              out += 'data: ' + JSON.stringify(chunk) + '\n';
            } catch {
              out += line + '\n';
            }
          }

          if (out.trim()) {
            if (!ttftFired) {
              latency.observe({ adapter: 'ollama', metric: 'ttft' }, Date.now() - t0);
              ttftFired = true;
            }
            res.write(out);
          }
        }
      } finally {
        res.end();
      }

      console.log(`[ollama-adapter] stream done model=${model}`);
    } else {
      const json = await ollamaRes.json() as { choices?: { message?: { content?: string } }[] };
      const msg = json.choices?.[0]?.message;
      if (msg?.content) msg.content = stripThinkTags(msg.content);
      console.log(
        `[ollama-adapter] done model=${model}` +
        ` textLen=${msg?.content?.length ?? 0}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    }
  }
}
