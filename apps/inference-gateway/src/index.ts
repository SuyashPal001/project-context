/**
 * Inference Gateway — OpenAI-compatible HTTP server
 *
 * Single entry point between AI SDK (model selectors) and model backends.
 * Adapter selection is handled by router.ts; each model backend adapter lives in adapters/.
 *
 * Port: 4001  (set PORT env var to override)
 */

import 'dotenv/config';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { GoogleAuth } from 'google-auth-library';
import type { OpenAIRequest } from './types';
import { getAdapterChain, getPrivateOnlyChain, vertexBreaker, anthropicBreaker, ollamaBreaker, openrouterBreaker, vertexImageBreaker, geminiImageBreaker, vertexMusicBreaker, geminiVideoBreaker } from './router';
import { requestsTotal, fallbacksTotal, latency, renderMetrics } from './metrics';
import { isAuthorizedCaller, extractServiceKey } from './auth';
import { handleImageGenerations } from './images.js';
import { handleMusicGenerations } from './music.js';
import { handleVideoGenerations } from './video.js';

// ---------------------------------------------------------------------------
// Embedding via Vertex AI text-embedding-004 (ADC via google-auth-library)
// ---------------------------------------------------------------------------

const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

async function handleEmbeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try { body = await readBody(req); } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
    return;
  }

  let payload: { model?: string; input: string | string[] };
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    return;
  }

  const embModel = payload.model ?? 'text-embedding-004';
  const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
  const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? '';
  const LOCATION = process.env.VERTEX_LOCATION ?? process.env.GCLOUD_LOCATION ?? 'us-central1';
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${embModel}:predict`;

  try {
    const client = await _auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = tokenResp.token;

    const vertexResp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: inputs.map(content => ({ content })) }),
    });

    if (!vertexResp.ok) {
      const errText = await vertexResp.text();
      console.error('[inference-gateway] embed error:', vertexResp.status, errText);
      res.writeHead(vertexResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: errText } }));
      return;
    }

    const vertexData = await vertexResp.json() as { predictions: Array<{ embeddings: { values: number[] } }> };
    const data = vertexData.predictions.map((p, i) => ({
      object: 'embedding' as const,
      index: i,
      embedding: p.embeddings.values,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data, model: embModel }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[inference-gateway] embed exception:', message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
  }
}

// ---------------------------------------------------------------------------
// Gemini-native embedContent / batchEmbedContents handler
// The @ai-sdk/google provider calls POST /v1/models/:model:embedContent
// (not /v1/embeddings). Mastra 1.64 probes embedder dimension at startup
// via this endpoint — a 404 here causes every session to fail immediately.
// ---------------------------------------------------------------------------

async function handleGeminiEmbedContent(req: IncomingMessage, res: ServerResponse, isBatch: boolean): Promise<void> {
  let body: string;
  try { body = await readBody(req); } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    return;
  }

  // Extract model name from URL: /v1/models/gemini-embedding-001:embedContent
  const modelMatch = req.url?.match(/\/v1\/models\/([^/:?]+)/);
  const embModel = modelMatch?.[1] ?? 'text-embedding-004';

  // Normalise to Vertex-compatible model name — gemini-embedding-001 is
  // available on Vertex under the same name; text-embedding-004 is the
  // fallback for older model IDs.
  const vertexModel = embModel.startsWith('gemini-embedding') ? embModel : 'text-embedding-004';

  // Extract text inputs from Gemini-native request format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extractText(content: any): string {
    if (typeof content === 'string') return content;
    const parts: Array<{ text?: string }> = content?.parts ?? [];
    return parts.map(p => p.text ?? '').join(' ');
  }

  const texts: string[] = isBatch
    ? (payload.requests ?? []).map((r: { content: unknown }) => extractText(r.content))
    : [extractText(payload.content)];

  const PROJECT  = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? '';
  const LOCATION = process.env.VERTEX_LOCATION ?? process.env.GCLOUD_LOCATION ?? 'us-central1';
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${vertexModel}:predict`;

  try {
    const client = await _auth.getClient();
    const tokenResp = await client.getAccessToken();

    const vertexResp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: texts.map(content => ({ content })) }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!vertexResp.ok) {
      const errText = await vertexResp.text();
      console.error('[inference-gateway] gemini-embed error:', vertexResp.status, errText);
      res.writeHead(vertexResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: errText } }));
      return;
    }

    const vertexData = await vertexResp.json() as { predictions: Array<{ embeddings: { values: number[] } }> };
    const values = vertexData.predictions.map(p => p.embeddings.values);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (isBatch) {
      // batchEmbedContents response: { embeddings: [{ values: [...] }] }
      res.end(JSON.stringify({ embeddings: values.map(v => ({ values: v })) }));
    } else {
      // embedContent response: { embedding: { values: [...] } }
      res.end(JSON.stringify({ embedding: { values: values[0] ?? [] } }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[inference-gateway] gemini-embed exception:', message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
  }
}

const PORT = parseInt(process.env.PORT ?? '4001', 10);
const DEFAULT_MODEL = process.env.VERTEX_MODEL ?? 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 40 * 1024 * 1024; // 40MB — covers a base64-inflated source image with headroom

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body', type: 'invalid_request_error' } }));
    return;
  }

  let payload: OpenAIRequest;
  try {
    payload = JSON.parse(body) as OpenAIRequest;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
    return;
  }

  const model = payload.model ?? DEFAULT_MODEL;
  const restricted = req.headers['x-data-classification'] === 'restricted';
  const chain = restricted ? getPrivateOnlyChain() : getAdapterChain(model);
  const tried: string[] = [];
  let lastError: unknown;

  // Wrap res.write to intercept SSE chunks and extract usage + tok/sec at gateway level
  const t0 = Date.now();
  let tFirstWrite = 0;
  let completionTokens = 0;
  const origWrite = res.write.bind(res);
  (res as ServerResponse).write = function (chunk: unknown, ...args: unknown[]) {
    if (!tFirstWrite) tFirstWrite = Date.now();
    const str = typeof chunk === 'string' ? chunk : (chunk instanceof Buffer ? chunk.toString() : '');
    if (str.startsWith('data: ') && !str.includes('[DONE]')) {
      try {
        const parsed = JSON.parse(str.slice(6)) as { usage?: { completion_tokens?: number } };
        if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens;
      } catch { /* non-JSON chunk, skip */ }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origWrite as any)(chunk, ...args);
  } as typeof res.write;

  for (const adapter of chain) {
    const name = (adapter as { adapterName?: string }).adapterName
      ?? adapter.constructor.name.replace('Adapter', '').toLowerCase();
    tried.push(name);
    try {
      await adapter.handleCompletion(payload, res);
      const totalMs = Date.now() - t0;
      const genMs = tFirstWrite > 0 ? Date.now() - tFirstWrite : totalMs;
      const ttft = tFirstWrite > 0 ? tFirstWrite - t0 : null;
      const tokPerSec = completionTokens > 0 && genMs > 0
        ? ((completionTokens / genMs) * 1000).toFixed(1)
        : 'n/a';
      console.log(
        `[gateway] done adapter=${name} model=${model}` +
        ` ttft=${ttft !== null ? ttft + 'ms' : 'n/a'} tok/s=${tokPerSec}` +
        ` completion_tokens=${completionTokens} total_ms=${totalMs}`,
      );
      latency.observe({ adapter: name }, totalMs);
      requestsTotal.inc({ adapter: name, status: 'success' });
      if (tried.length > 1) {
        const prev = tried[tried.length - 2];
        fallbacksTotal.inc({ from: prev, to: name });
        console.log(`[gateway] fallback succeeded: ${tried.slice(0, -1).join(' → ')} failed, used ${name}`);
      }
      return;
    } catch (err) {
      latency.observe({ adapter: name }, Date.now() - t0);
      requestsTotal.inc({ adapter: name, status: 'failure' });
      lastError = err;
      if (res.headersSent) {
        console.error(`[gateway] ${name} failed mid-stream, cannot fall back: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
        if (!res.writableEnded) res.end();
        return;
      }
      console.warn(`[gateway] ${name} failed, trying next in chain: ${err instanceof Error ? err.message : err}`);
    }
  }

  // All adapters exhausted
  const message = lastError instanceof Error ? lastError.message : 'All model backends unavailable';
  console.error(`[gateway] all adapters exhausted: ${tried.join(' → ')}`);
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'api_error', tried } }));
}

/**
 * Native Gemini API pass-through.
 * The relay no longer hits this path (switched to @ai-sdk/openai-compatible → /v1/chat/completions).
 * Kept as a generic escape hatch for any client that sends raw Gemini-format requests
 * (e.g. direct curl tests, future non-Mastra integrations, Mastra Studio internals).
 * Does NOT go through the adapter chain — no fallback, no circuit breaker, no tok/s logging.
 */
async function handleNativeGemini(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Lazy import to avoid pulling in vertexai at top level for this edge case
  const { VertexAI } = await import('@google-cloud/vertexai');
  const PROJECT = process.env.VERTEX_PROJECT ?? '';
  const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';
  const vertexAI = new VertexAI({ project: PROJECT, location: LOCATION });

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
    return;
  }
  const modelMatch = req.url?.match(/models\/([^/:?]+)/);
  const nativeModelName = modelMatch?.[1] ?? DEFAULT_MODEL;

  console.log(`[inference-gateway] native Gemini via Vertex AI: ${req.method} model=${nativeModelName}`);

  const isStreaming = req.url?.includes('streamGenerateContent') ?? false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nativeRequest = (body ? JSON.parse(body) : {}) as any;
    console.log('[inference-gateway] native-gemini tools:', JSON.stringify(nativeRequest.tools ?? null));
    const nativeModel = vertexAI.getGenerativeModel({ model: nativeModelName });

    if (isStreaming) {
      console.log('[inference-gateway] streaming via generateContentStream');
      const streamResult = await nativeModel.generateContentStream(nativeRequest);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const t0 = Date.now();
      let tFirstChunk = 0;
      let completionTokens = 0;
      let promptTokens = 0;
      for await (const chunk of streamResult.stream) {
        if (!tFirstChunk) tFirstChunk = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (chunk as any).usageMetadata;
        if (meta?.candidatesTokenCount) completionTokens = meta.candidatesTokenCount;
        if (meta?.promptTokenCount) promptTokens = meta.promptTokenCount;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      const totalMs = Date.now() - t0;
      const genMs = tFirstChunk > 0 ? Date.now() - tFirstChunk : totalMs;
      const ttft = tFirstChunk > 0 ? tFirstChunk - t0 : null;
      const tokPerSec = completionTokens > 0 && genMs > 0
        ? ((completionTokens / genMs) * 1000).toFixed(1)
        : 'n/a';
      console.log(
        `[gateway] done adapter=vertex model=${nativeModelName}` +
        ` ttft=${ttft !== null ? ttft + 'ms' : 'n/a'} tok/s=${tokPerSec}` +
        ` prompt_tokens=${promptTokens} completion_tokens=${completionTokens} total_ms=${totalMs}`,
      );
    } else {
      const t0 = Date.now();
      const result = await nativeModel.generateContent(nativeRequest);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (result.response as any).usageMetadata;
      console.log(
        `[gateway] done adapter=vertex model=${nativeModelName} (non-stream)` +
        ` prompt_tokens=${meta?.promptTokenCount ?? 0} completion_tokens=${meta?.candidatesTokenCount ?? 0}` +
        ` total_ms=${Date.now() - t0}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.response));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[inference-gateway] native Gemini error:', message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message, type: 'api_error' } }));
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      model: DEFAULT_MODEL,
      circuits: {
        vertex:       vertexBreaker.getStatus(),
        anthropic:    anthropicBreaker.getStatus(),
        ollama:       ollamaBreaker.getStatus(),
        openrouter:   openrouterBreaker.getStatus(),
        vertexImage:  vertexImageBreaker.getStatus(),
        geminiImage:  geminiImageBreaker.getStatus(),
        vertexMusic:  vertexMusicBreaker.getStatus(),
        geminiVideo:  geminiVideoBreaker.getStatus(),
      },
    }));
    return;
  }

  // ── Authentication ────────────────────────────────────────────────────────
  // Everything past this point either spends money on model inference or
  // discloses operational detail, and this process forwards to Vertex using the
  // VM's own GCP credentials. Only /health above is public, so a liveness probe
  // still works. Placed before route dispatch so a new route cannot be added
  // unprotected by accident.
  if (!isAuthorizedCaller(extractServiceKey(req.headers))) {
    console.warn(`[inference-gateway] 401 unauthenticated: ${req.method} ${req.url}`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Unauthorized', type: 'invalid_request_error' },
    }));
    return;
  }

  // Prometheus metrics scrape endpoint
  if (req.method === 'GET' && req.url === '/metrics') {
    const body = renderMetrics({
      vertex:       vertexBreaker.getStatus(),
      anthropic:    anthropicBreaker.getStatus(),
      ollama:       ollamaBreaker.getStatus(),
      openrouter:   openrouterBreaker.getStatus(),
      vertexImage:  vertexImageBreaker.getStatus(),
      geminiImage:  geminiImageBreaker.getStatus(),
      vertexMusic:  vertexMusicBreaker.getStatus(),
      geminiVideo:  geminiVideoBreaker.getStatus(),
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
    return;
  }

  // Models list (some clients probe this)
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'google' }],
    }));
    return;
  }

  // Embeddings
  if (req.method === 'POST' && req.url === '/v1/embeddings') {
    await handleEmbeddings(req, res);
    return;
  }

  // Chat completions (main path)
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await handleChatCompletions(req, res);
    return;
  }

  // Image generation (Director agent)
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    await handleImageGenerations(req, res, readBody);
    return;
  }

  // Music generation (Producer agent)
  if (req.method === 'POST' && req.url === '/v1/music/generations') {
    await handleMusicGenerations(req, res, readBody);
    return;
  }

  // Video generation (Director agent)
  if (req.method === 'POST' && req.url === '/v1/video/generations') {
    await handleVideoGenerations(req, res, readBody);
    return;
  }

  // Gemini-native embedding endpoints (@ai-sdk/google provider format)
  if (req.method === 'POST' && req.url?.includes(':embedContent')) {
    await handleGeminiEmbedContent(req, res, false);
    return;
  }
  if (req.method === 'POST' && req.url?.includes(':batchEmbedContents')) {
    await handleGeminiEmbedContent(req, res, true);
    return;
  }

  // Native Gemini API pass-through
  if (
    req.url?.includes('v1beta') ||
    req.url?.includes('generateContent') ||
    req.url?.includes('streamGenerateContent') ||
    req.url?.includes('/v1/v1beta')
  ) {
    await handleNativeGemini(req, res);
    return;
  }

  console.log(`[inference-gateway] 404 unhandled: ${req.method} ${req.url}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
});

// Refuse to start unauthenticated rather than run as an open proxy to billable
// inference. A process that exits on deploy is discoverable; one that silently
// serves anonymous callers is not.
if (!process.env.INTERNAL_SERVICE_KEY) {
  console.error(
    '[inference-gateway] INTERNAL_SERVICE_KEY is not set. This service holds GCP ' +
    'credentials and bills real inference; it will not start unauthenticated.',
  );
  process.exit(1);
}

// Bind loopback by default. Every caller runs on this VM, so listening on all
// interfaces put billable inference one firewall rule away from the internet.
// Set INFERENCE_BIND_HOST only if a genuinely remote caller is introduced.
const HOST = process.env.INFERENCE_BIND_HOST ?? '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`vertex-proxy listening on http://${HOST}:${PORT}`);
  console.log(`  default model: ${DEFAULT_MODEL}`);
});

process.on('uncaughtException', (err) => console.error('[inference-gateway] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[inference-gateway] unhandledRejection:', err));
