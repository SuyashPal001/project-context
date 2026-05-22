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
import { getAdapterChain, vertexBreaker, anthropicBreaker, ollamaBreaker } from './router';
import { requestsTotal, fallbacksTotal, latency, renderMetrics } from './metrics';

// ---------------------------------------------------------------------------
// Embedding via Vertex AI text-embedding-004 (ADC via google-auth-library)
// ---------------------------------------------------------------------------

const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

async function handleEmbeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try { body = await readBody(req); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
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

const PORT = parseInt(process.env.PORT ?? '4001', 10);
const DEFAULT_MODEL = process.env.VERTEX_MODEL ?? 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
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
  const chain = getAdapterChain(model);
  const tried: string[] = [];
  let lastError: unknown;

  for (const adapter of chain) {
    const name = (adapter as { adapterName?: string }).adapterName
      ?? adapter.constructor.name.replace('Adapter', '').toLowerCase();
    tried.push(name);
    const t0 = Date.now();
    try {
      await adapter.handleCompletion(payload, res);
      latency.observe({ adapter: name }, Date.now() - t0);
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
        console.error(`[gateway] ${name} failed mid-stream, cannot fall back`);
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
 * @ai-sdk/google hits /v1/models/:model:generateContent in Google AI format.
 * web_search is now handled by Exa (real function call) so no tool transformation needed.
 */
async function handleNativeGemini(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Lazy import to avoid pulling in vertexai at top level for this edge case
  const { VertexAI } = await import('@google-cloud/vertexai');
  const PROJECT = process.env.VERTEX_PROJECT ?? '';
  const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';
  const vertexAI = new VertexAI({ project: PROJECT, location: LOCATION });

  const body = await readBody(req);
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
      for await (const chunk of streamResult.stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const result = await nativeModel.generateContent(nativeRequest);
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
        vertex:    vertexBreaker.getStatus(),
        anthropic: anthropicBreaker.getStatus(),
        ollama:    ollamaBreaker.getStatus(),
      },
    }));
    return;
  }

  // Prometheus metrics scrape endpoint
  if (req.method === 'GET' && req.url === '/metrics') {
    const body = renderMetrics({
      vertex:    vertexBreaker.getStatus(),
      anthropic: anthropicBreaker.getStatus(),
      ollama:    ollamaBreaker.getStatus(),
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

server.listen(PORT, () => {
  console.log(`vertex-proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`  default model: ${DEFAULT_MODEL}`);
});

process.on('uncaughtException', (err) => console.error('[inference-gateway] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[inference-gateway] unhandledRejection:', err));
