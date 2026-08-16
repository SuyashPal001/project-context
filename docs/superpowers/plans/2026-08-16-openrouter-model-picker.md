# OpenRouter Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat input's model picker actually change which model answers, by adding an OpenRouter adapter to inference-gateway and wiring the existing (but currently inert) `agent.llmProviderId` selection into the Mastra web-chat path.

**Architecture:** Extends the existing `inference-gateway` adapter pattern with a new `OpenRouterAdapter` (OpenAI-compatible passthrough, no translation needed). `apps/agent-orchestrator`'s `platformAgent` currently picks from 3 hardcoded model connectors; it gains a 4th precedence tier that reads a per-request `selectedModel` string resolved from the agent's `llmProviderId` via a new DB lookup. The frontend renders the picker UI that was already half-wired (`ChatInput.tsx` accepts `providers`/`onModelChange` props but never used them).

**Tech Stack:** TypeScript, Hono, `@ai-sdk/openai-compatible`, Mastra (`@mastra/core`), Drizzle/raw `pg`, Next.js, shadcn `DropdownMenu`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-openrouter-model-picker-design.md`

## Global Constraints

- No fallback chain for OpenRouter — `getAdapterChain()` returns `[openrouterCB]` only, matching the spec's "no silent model substitution" decision.
- The restricted-data guardrail (`privateModel`) always wins over any user-selected model — checked first, unconditionally, in `selectModel`.
- Seeded OpenRouter provider rows ship as `status: 'coming_soon'` — no real `OPENROUTER_API_KEY` exists yet (spec: "Build with placeholder, wire later").
- Any lookup failure (missing `llmProviderId`, missing row, `status !== 'live'`, DB error) falls through to today's default model selection — never blocks or errors a chat turn.
- Cost tiers are computed by ranking `costPerToken` client-side into thirds ($/$$/$$$) — no hardcoded dollar thresholds.

---

### Task 1: OpenRouter adapter in inference-gateway

**Files:**
- Create: `apps/inference-gateway/src/adapters/openrouter.ts`
- Create: `apps/inference-gateway/src/adapters/openrouter.test.ts`
- Modify: `apps/inference-gateway/.env.example`

**Interfaces:**
- Consumes: `ProviderAdapter` interface and `AdapterError` class from `./base` (existing).
- Produces: `export class OpenRouterAdapter implements ProviderAdapter` with `handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void>` — consumed by Task 2's router wiring.

- [ ] **Step 1: Write the failing test**

Create `apps/inference-gateway/src/adapters/openrouter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { OpenRouterAdapter } from './openrouter';
import { AdapterError } from './base';
import type { OpenAIRequest } from '../types';

function createMockRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let ended = false;
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { statusCode = code; headers = h ?? {}; },
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); ended = true; },
    headersSent: false,
  };
  return {
    res: res as unknown as ServerResponse,
    get chunks() { return chunks; },
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    get ended() { return ended; },
  };
}

const baseReq: OpenAIRequest = {
  model: 'openrouter/anthropic/claude-opus-5',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenRouterAdapter', () => {
  const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it('fails fast with no network call when OPENROUTER_API_KEY is unset', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await expect(adapter.handleCompletion(baseReq, res)).rejects.toThrow(AdapterError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strips the openrouter/ prefix and forwards to the OpenRouter API with auth + attribution headers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'x', object: 'chat.completion', choices: [], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await adapter.handleCompletion(baseReq, res);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer test-key');
    expect(init.headers['HTTP-Referer']).toBeTruthy();
    expect(init.headers['X-Title']).toBeTruthy();
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe('anthropic/claude-opus-5');
  });

  it('throws AdapterError with the upstream status on a non-ok response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res } = createMockRes();

    await expect(adapter.handleCompletion(baseReq, res)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('pipes a non-streaming JSON response straight through', async () => {
    const upstreamJson = { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => upstreamJson });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OpenRouterAdapter();
    const { res, chunks, statusCode } = createMockRes();

    await adapter.handleCompletion({ ...baseReq, stream: false }, res);

    expect(statusCode).toBe(200);
    expect(JSON.parse(chunks.join(''))).toEqual(upstreamJson);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && pnpm exec vitest run src/adapters/openrouter.test.ts`
Expected: FAIL — `Cannot find module './openrouter'` (file doesn't exist yet).

- [ ] **Step 3: Write the adapter**

Create `apps/inference-gateway/src/adapters/openrouter.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && pnpm exec vitest run src/adapters/openrouter.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Add the env placeholder**

In `apps/inference-gateway/.env.example`, add (near the other provider keys, e.g. `ANTHROPIC_API_KEY`):

```
# OpenRouter — used by OpenRouterAdapter for model-picker "openrouter/*" models.
# Unset by default; requests routed to it fail fast with a clear error until set.
OPENROUTER_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add apps/inference-gateway/src/adapters/openrouter.ts apps/inference-gateway/src/adapters/openrouter.test.ts apps/inference-gateway/.env.example
git commit -m "feat(inference-gateway): add OpenRouter adapter"
```

---

### Task 2: Wire the adapter into the router and health/metrics

**Files:**
- Modify: `apps/inference-gateway/src/router.ts`
- Create: `apps/inference-gateway/src/router.test.ts`
- Modify: `apps/inference-gateway/src/index.ts`

**Interfaces:**
- Consumes: `OpenRouterAdapter` from Task 1 (`./adapters/openrouter.js`).
- Produces: `openrouterBreaker` exported from `router.ts` (consumed by `index.ts`'s `/health` and `/metrics` handlers, same pattern as `vertexBreaker`/`anthropicBreaker`/`ollamaBreaker`). `getAdapterChain()` now routes `openrouter/*` model strings.

- [ ] **Step 1: Write the failing test**

Create `apps/inference-gateway/src/router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getAdapterChain, getPrivateOnlyChain } from './router';

describe('getAdapterChain', () => {
  it('routes openrouter/* models to the OpenRouter adapter only, no fallback', () => {
    const chain = getAdapterChain('openrouter/anthropic/claude-opus-5');
    expect(chain).toHaveLength(1);
    expect((chain[0] as { adapterName?: string }).adapterName).toBe('openrouter');
  });

  it('still routes claude-* models to Anthropic then Ollama, unaffected', () => {
    const chain = getAdapterChain('claude-sonnet-4-5');
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).toEqual(['anthropic', 'ollama']);
  });

  it('does not put openrouter in the default (Gemini) chain', () => {
    const chain = getAdapterChain('gemini-2.5-flash');
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).not.toContain('openrouter');
  });
});

describe('getPrivateOnlyChain', () => {
  it('never includes openrouter — restricted data must stay on Ollama', () => {
    const chain = getPrivateOnlyChain();
    const names = chain.map((a) => (a as { adapterName?: string }).adapterName);
    expect(names).toEqual(['ollama']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && pnpm exec vitest run src/router.test.ts`
Expected: FAIL on the first test — `getAdapterChain('openrouter/...')` currently falls through to the default Gemini chain (`vertex`/`gemini`/`ollama`), so `chain` has length > 1 and `adapterName` isn't `'openrouter'`.

- [ ] **Step 3: Wire the adapter into the router**

In `apps/inference-gateway/src/router.ts`, update the doc comment and add the new adapter/breaker/rule:

```typescript
/**
 * Inference Gateway router — selects the right adapter based on the requested model.
 *
 * Routing rules (first match wins):
 *   openrouter/* → OpenRouterAdapter  (cloud model backend, no fallback)
 *   claude-*    → AnthropicAdapter  (Anthropic model backend)
 *   gemini-*    → VertexAdapter (ADC) → GeminiAdapter (API key) → Ollama
 *   ollama/*    → OllamaAdapter     (local model backend)
 *   (default)   → VertexAdapter → GeminiAdapter → Ollama
 */

import type { ProviderAdapter } from './adapters/base';
import { VertexAdapter } from './adapters/vertex';
import { AnthropicAdapter } from './adapters/anthropic';
import { OllamaAdapter } from './adapters/ollama';
import { GeminiAdapter } from './adapters/gemini';
import { OpenRouterAdapter } from './adapters/openrouter';
import { CircuitBreaker, CircuitBreakerAdapter } from './circuit-breaker';

const vertexAdapter     = new VertexAdapter();
const anthropicAdapter  = new AnthropicAdapter();
const ollamaAdapter     = new OllamaAdapter();
const geminiAdapter     = new GeminiAdapter();
const openrouterAdapter = new OpenRouterAdapter();

export const vertexBreaker     = new CircuitBreaker('vertex',     { failureThreshold: 10, resetTimeoutMs: 60_000 });
export const anthropicBreaker  = new CircuitBreaker('anthropic',  { failureThreshold: 3, resetTimeoutMs: 60_000 });
export const ollamaBreaker     = new CircuitBreaker('ollama',     { failureThreshold: 5, resetTimeoutMs: 30_000 });
export const geminiBreaker     = new CircuitBreaker('gemini',     { failureThreshold: 5, resetTimeoutMs: 60_000 });
export const openrouterBreaker = new CircuitBreaker('openrouter', { failureThreshold: 5, resetTimeoutMs: 60_000 });

const vertexCB     = new CircuitBreakerAdapter(vertexAdapter,     vertexBreaker);
const anthropicCB  = new CircuitBreakerAdapter(anthropicAdapter,  anthropicBreaker);
const ollamaCB     = new CircuitBreakerAdapter(ollamaAdapter,     ollamaBreaker);
const geminiCB     = new CircuitBreakerAdapter(geminiAdapter,     geminiBreaker);
const openrouterCB = new CircuitBreakerAdapter(openrouterAdapter, openrouterBreaker);

/**
 * Returns an ordered fallback chain for the requested model.
 * The handler tries each adapter in sequence — moving to the next only if
 * the current one throws (AdapterError or any error) before headers are sent.
 *
 * Fallback order:
 *   openrouter/* → OpenRouter only (user explicitly picked this model — no silent substitution)
 *   gemini-*     → Vertex AI (ADC) → Gemini API key → Ollama
 *   claude-*     → Anthropic → Ollama
 *   ollama/*     → Ollama only (local — nowhere to fall back to)
 */
export function getAdapterChain(model: string | undefined): ProviderAdapter[] {
  const m = model ?? '';
  if (m.startsWith('openrouter/')) return [openrouterCB];
  if (m.startsWith('claude'))  return [anthropicCB, ollamaCB];
  if (m.startsWith('ollama/')) return [ollamaCB];
  // Gemini models: Vertex AI (ADC) first, then direct Gemini API key, then Ollama
  const chain: ProviderAdapter[] = [vertexCB];
  if (geminiAdapter.isAvailable()) chain.push(geminiCB);
  chain.push(ollamaCB);
  return chain;
}

/**
 * Private-only chain — used when X-Data-Classification: restricted is set.
 * Restricted data (CASA/KYC) must never be sent to cloud providers.
 */
export function getPrivateOnlyChain(): ProviderAdapter[] {
  return [ollamaCB];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && pnpm exec vitest run src/router.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Report the new circuit in health/metrics**

In `apps/inference-gateway/src/index.ts`:

Update the import:
```typescript
import { getAdapterChain, getPrivateOnlyChain, vertexBreaker, anthropicBreaker, ollamaBreaker, openrouterBreaker } from './router';
```

Update the `/health` handler's `circuits` object:
```typescript
      circuits: {
        vertex:     vertexBreaker.getStatus(),
        anthropic:  anthropicBreaker.getStatus(),
        ollama:     ollamaBreaker.getStatus(),
        openrouter: openrouterBreaker.getStatus(),
      },
```

Update the `/metrics` handler's call to `renderMetrics`:
```typescript
    const body = renderMetrics({
      vertex:     vertexBreaker.getStatus(),
      anthropic:  anthropicBreaker.getStatus(),
      ollama:     ollamaBreaker.getStatus(),
      openrouter: openrouterBreaker.getStatus(),
    });
```

- [ ] **Step 6: Run the full inference-gateway test suite**

Run: `cd apps/inference-gateway && pnpm exec vitest run`
Expected: PASS — all existing tests plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/inference-gateway/src/router.ts apps/inference-gateway/src/router.test.ts apps/inference-gateway/src/index.ts
git commit -m "feat(inference-gateway): route openrouter/* models to the new adapter"
```

---

### Task 3: Model resolution helpers in agent-orchestrator

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/model.ts`
- Create: `apps/agent-orchestrator/src/mastra/__tests__/model.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `gateway` factory in this file).
- Produces: `export function resolveModel(modelString: string)` and `export function buildGatewayModelString(provider: string, model: string): string | null` — both consumed by Task 4 (`resolveModel` by `modelSelection.ts`) and Task 5 (`buildGatewayModelString` by `chatStream.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/__tests__/model.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveModel, buildGatewayModelString } from '../model.js'

describe('buildGatewayModelString', () => {
  it('prefixes openrouter models with the gateway routing prefix', () => {
    expect(buildGatewayModelString('openrouter', 'anthropic/claude-opus-5')).toBe('openrouter/anthropic/claude-opus-5')
  })

  it('passes anthropic models through unchanged (already claude-* shaped)', () => {
    expect(buildGatewayModelString('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('passes vertex models through unchanged (already gemini-* shaped)', () => {
    expect(buildGatewayModelString('vertex', 'gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })

  it('returns null for providers the gateway does not route yet, so callers fall through to defaults', () => {
    expect(buildGatewayModelString('openai', 'gpt-5.1')).toBeNull()
    expect(buildGatewayModelString('mistral', 'mistral-large')).toBeNull()
    expect(buildGatewayModelString('kimi', 'kimi-k2')).toBeNull()
  })
})

describe('resolveModel', () => {
  it('builds a model connector whose modelId matches the given string', () => {
    const model = resolveModel('openrouter/anthropic/claude-opus-5')
    expect(model.modelId).toBe('openrouter/anthropic/claude-opus-5')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/__tests__/model.test.ts`
Expected: FAIL — `resolveModel` and `buildGatewayModelString` are not exported from `../model.js`.

- [ ] **Step 3: Add the helpers**

In `apps/agent-orchestrator/src/mastra/model.ts`, append after the existing `privateModel` export:

```typescript
// Builds a model connector from an arbitrary model string at request time — used
// when a user has picked a specific model via the chat UI's model picker, rather
// than one of the three module-level constants above.
export function resolveModel(modelString: string) {
  return gateway(modelString)
}

// Maps an llm_providers row's {provider, model} into the model-string convention
// router.ts dispatches on (see apps/inference-gateway/src/router.ts). Returns null
// for providers the gateway doesn't route yet (openai, mistral, kimi) so callers can
// fall through to default model selection instead of sending a string nothing handles.
export function buildGatewayModelString(provider: string, model: string): string | null {
  if (provider === 'openrouter') return `openrouter/${model}`
  if (provider === 'anthropic' || provider === 'vertex') return model
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/__tests__/model.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/model.ts apps/agent-orchestrator/src/mastra/__tests__/model.test.ts
git commit -m "feat(agent-orchestrator): add resolveModel/buildGatewayModelString helpers"
```

---

### Task 4: Extract and wire `selectModel` into platformAgent

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/agents/modelSelection.ts`
- Create: `apps/agent-orchestrator/src/mastra/agents/__tests__/modelSelection.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: `platformModel`, `liteModel`, `privateModel`, `resolveModel` from `../model.js` (existing + Task 3).
- Produces: `export function selectModel({ requestContext }: { requestContext?: RequestContext })`, consumed by `platformAgent.ts`'s `model:` field. Reads `requestContext.get('selectedModel')` — the key Task 5's `chatStream.ts` change will set.

**Why extract:** `platformAgent.ts` builds `getMastraMemory()` and other DB/network-touching singletons at module load; importing it directly in a test risks the same `ECONNREFUSED :5432` failure this codebase already has in `tasks-plan.test.ts`. `modelSelection.ts` only imports the lightweight `model.js` module, so it's safe to unit test in isolation.

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/agents/__tests__/modelSelection.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../model.js', () => ({
  platformModel: 'PLATFORM_MODEL',
  liteModel: 'LITE_MODEL',
  privateModel: 'PRIVATE_MODEL',
  resolveModel: vi.fn((modelString: string) => `RESOLVED(${modelString})`),
}))

import { selectModel } from '../modelSelection.js'
import { resolveModel } from '../../model.js'

function makeContext(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] }
}

describe('selectModel', () => {
  it('returns privateModel for restricted data, ignoring any selected model', () => {
    const ctx = makeContext({ maxDataSensitivity: 'restricted', selectedModel: 'openrouter/anthropic/claude-opus-5' })
    expect(selectModel({ requestContext: ctx as any })).toBe('PRIVATE_MODEL')
  })

  it('resolves a user-selected model when one is set and data is not restricted', () => {
    const ctx = makeContext({ selectedModel: 'openrouter/anthropic/claude-opus-5' })
    const result = selectModel({ requestContext: ctx as any })
    expect(resolveModel).toHaveBeenCalledWith('openrouter/anthropic/claude-opus-5')
    expect(result).toBe('RESOLVED(openrouter/anthropic/claude-opus-5)')
  })

  it('falls back to liteModel when thinkingBudget is 0 and no model is selected', () => {
    const ctx = makeContext({ thinkingBudget: 0 })
    expect(selectModel({ requestContext: ctx as any })).toBe('LITE_MODEL')
  })

  it('falls back to platformModel by default', () => {
    const ctx = makeContext({})
    expect(selectModel({ requestContext: ctx as any })).toBe('PLATFORM_MODEL')
  })

  it('handles a missing requestContext', () => {
    expect(selectModel({ requestContext: undefined as any })).toBe('PLATFORM_MODEL')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/agents/__tests__/modelSelection.test.ts`
Expected: FAIL — `Cannot find module '../modelSelection.js'`.

- [ ] **Step 3: Write `modelSelection.ts`**

Create `apps/agent-orchestrator/src/mastra/agents/modelSelection.ts`:

```typescript
import type { RequestContext } from '@mastra/core/request-context'
import { platformModel, liteModel, privateModel, resolveModel } from '../model.js'

// Dynamic model selection, in precedence order:
//   1. restricted data (CASA/KYC) → private model only — non-negotiable, checked first
//   2. a user-selected model (via the chat UI's model picker, set by chatStream.ts
//      onto requestContext as 'selectedModel') → resolved on demand
//   3. thinkingBudget=0 → lite model (conversational turns)
//   4. default → full model
//
// Typed with a required `requestContext` to match platformAgent.ts's original inline
// function (and Mastra's DynamicArgument signature) — but still reached defensively
// via `?.` below, since the original code did too despite the non-optional type.
export function selectModel({ requestContext }: { requestContext: RequestContext }) {
  const sensitivity = requestContext?.get('maxDataSensitivity') as string | undefined
  if (sensitivity === 'restricted') return privateModel

  const selectedModel = requestContext?.get('selectedModel') as string | undefined
  if (selectedModel) return resolveModel(selectedModel)

  const budget = requestContext?.get('thinkingBudget') as number | undefined
  return budget === 0 ? liteModel : platformModel
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/agents/__tests__/modelSelection.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Wire it into platformAgent.ts**

In `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`:

Add the import near the existing `model.js` import:
```typescript
import { platformModel, liteModel, privateModel } from '../model.js'
import { selectModel } from './modelSelection.js'
```
(Keep the existing `platformModel`/`liteModel`/`privateModel` import — other code in this file may still reference them; if a type-check pass shows any of the three now unused in this file specifically, remove only the unused names from this import line, not the line itself.)

Replace the inline dynamic `model` function:
```typescript
  // Dynamic model selection:
  //   restricted data (CASA/KYC) → private model only (set by fetchAgentContext tool)
  //   thinkingBudget=0           → lite model (conversational turns)
  //   default                    → full model
  model: ({ requestContext }: { requestContext: RequestContext }) => {
    const sensitivity = requestContext?.get('maxDataSensitivity') as string | undefined
    if (sensitivity === 'restricted') return privateModel
    const budget = requestContext?.get('thinkingBudget') as number | undefined
    return budget === 0 ? liteModel : platformModel
  },
```
with:
```typescript
  // Dynamic model selection — see modelSelection.ts for the precedence order and
  // why it's a separate module (testability: this file eagerly builds DB/network
  // singletons like getMastraMemory() at import time).
  model: selectModel,
```

- [ ] **Step 6: Type-check**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit -p . 2>&1 | grep -i platformAgent`
Expected: no output (no new errors introduced in this file). Pre-existing unrelated errors elsewhere in the package are expected and not this task's concern.

- [ ] **Step 7: Run the full agent-orchestrator test suite**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run`
Expected: PASS on all tests except the pre-existing `tasks-plan.test.ts` Postgres-connection failure (unrelated to this change, requires local Postgres on 5432).

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/modelSelection.ts apps/agent-orchestrator/src/mastra/agents/__tests__/modelSelection.test.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(agent-orchestrator): wire user-selected model into platformAgent"
```

---

### Task 5: Resolve the agent's selected model into each chat request

**Files:**
- Modify: `apps/agent-orchestrator/src/usage.ts`
- Modify: `apps/agent-orchestrator/src/usage.test.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`

**Interfaces:**
- Consumes: `buildGatewayModelString` from `../mastra/model.js` (Task 3).
- Produces: `export interface AgentModelSelection { provider: string; model: string; status: string }` and `export async function fetchAgentModelSelection(agentId: string): Promise<AgentModelSelection | null>` in `usage.ts`. `chatStream.ts` sets `requestContext.set('selectedModel', ...)` — the key Task 4's `selectModel` reads.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent-orchestrator/src/usage.test.ts` (below the existing `fetchToolGovernance` describe block — note the file already mocks `./db.js`'s `makeAppPool` at the top; extend that mock to expose a query spy this test can configure):

```typescript
import { describe, it, expect, vi } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('./db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { getAgentTools } from '@serverless-saas/ai'
import { fetchToolGovernance, fetchAgentModelSelection } from './usage.js'

// ... existing fetchToolGovernance describe block stays unchanged ...

describe('fetchAgentModelSelection', () => {
  it('returns provider/model/status when the agent has an llm_provider_id set', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ provider: 'openrouter', model: 'anthropic/claude-opus-5', status: 'live' }],
    })
    const result = await fetchAgentModelSelection('agent-1')
    expect(result).toEqual({ provider: 'openrouter', model: 'anthropic/claude-opus-5', status: 'live' })
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('llm_providers'), ['agent-1'])
  })

  it('returns null when the agent has no llm_provider_id (no matching row)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const result = await fetchAgentModelSelection('agent-2')
    expect(result).toBeNull()
  })
})
```

Note: this file already has its own top-level `vi.mock('./db.js', ...)` — the step above replaces that mock factory's return value to include `on: vi.fn()` (required because `fetchAgentModelSelection` calls the shared `getPool()`, which calls `pool.on('error', ...)`) and to expose `mockPoolQuery` so the new tests can configure return values per call.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/usage.test.ts`
Expected: FAIL — `fetchAgentModelSelection` is not exported from `./usage.js`.

- [ ] **Step 3: Add `fetchAgentModelSelection`**

In `apps/agent-orchestrator/src/usage.ts`, add after `fetchAgentPersonality`:

```typescript
export interface AgentModelSelection {
  provider: string
  model: string
  status: string
}

export async function fetchAgentModelSelection(agentId: string): Promise<AgentModelSelection | null> {
  const p = getPool()
  const res = await p.query<{ provider: string; model: string; status: string }>(
    `SELECT lp.provider, lp.model, lp.status
     FROM agents a
     JOIN llm_providers lp ON lp.id = a.llm_provider_id
     WHERE a.id = $1`,
    [agentId],
  )
  const row = res.rows[0]
  if (!row) return null
  return { provider: row.provider, model: row.model, status: row.status }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/usage.test.ts`
Expected: PASS — all tests in the file green (existing `fetchToolGovernance` tests plus the 2 new ones).

- [ ] **Step 5: Wire it into chatStream.ts**

In `apps/agent-orchestrator/src/routes/chatStream.ts`, update the import block:

```typescript
import { fetchAgentSkill, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection } from '../usage.js'
import { buildGatewayModelString } from '../mastra/model.js'
```

Find this exact block in the file (it comes right after the `mcpClient`/`__mcpClient` setup):
```typescript
    const [agentSkill, agentName, personaPersonality] = await Promise.all([
      fetchAgentSkill(agentId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
    ])
    if (agentSkill?.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
    }
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
```
and replace it with:
```typescript
    const [agentSkill, agentName, personaPersonality, agentModelSelection] = await Promise.all([
      fetchAgentSkill(agentId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
    ])
    if (agentSkill?.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
    }
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
    if (agentModelSelection && agentModelSelection.status === 'live') {
      const modelString = buildGatewayModelString(agentModelSelection.provider, agentModelSelection.model)
      if (modelString) requestContext.set('selectedModel', modelString)
    }
```

Everything else in the file (the `mcpClient` setup above this block, and all code below it) stays unchanged — this only adds one field to the destructured array, one more parallel fetch (wrapped in `.catch()` so a DB error here can never fail the whole chat turn, per the Global Constraints fail-open rule), and one more `if` block in the same style as the two already there.

- [ ] **Step 6: Type-check**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit -p . 2>&1 | grep -i "chatStream.ts\|usage.ts"`
Expected: no output.

- [ ] **Step 7: Run the full agent-orchestrator test suite**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run`
Expected: PASS on all tests except the pre-existing unrelated Postgres-connection failure in `tasks-plan.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/usage.ts apps/agent-orchestrator/src/usage.test.ts apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(agent-orchestrator): resolve agent's selected model into each chat request"
```

---

### Task 6: Expose `costPerToken` from the llm-providers route

**Files:**
- Modify: `products/agent-platform/packages/api/routes/llm-providers.ts`

**Interfaces:**
- Consumes: `llmProviders.costPerToken` (existing schema column).
- Produces: `GET /api/v1/llm-providers` response rows gain a `costPerToken: string | null` field — consumed by Task 8/9's frontend work.

- [ ] **Step 1: Update the route**

In `products/agent-platform/packages/api/routes/llm-providers.ts`, replace the full file:

```typescript
import { Hono } from 'hono';
import { eq, desc, asc } from 'drizzle-orm';
import { db } from '@serverless-saas/database/client';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import type { AppEnv } from '@serverless-saas/types';

export const llmProvidersRoutes = new Hono<AppEnv>();

// GET /llm-providers — List platform LLM providers for model selector
llmProvidersRoutes.get('/', async (c) => {
    const data = await db
        .select({
            id: llmProviders.id,
            provider: llmProviders.provider,
            model: llmProviders.model,
            displayName: llmProviders.displayName,
            isDefault: llmProviders.isDefault,
            status: llmProviders.status,
            costPerToken: llmProviders.costPerToken,
        })
        .from(llmProviders)
        .where(eq(llmProviders.isPlatform, true))
        .orderBy(desc(llmProviders.isDefault), asc(llmProviders.displayName));

    return c.json({
        providers: data.map((row: any) => ({
            id: row.id,
            provider: row.provider,
            model: row.model,
            displayName: row.displayName ?? row.model,
            isDefault: row.isDefault,
            status: row.status as 'live' | 'coming_soon',
            costPerToken: row.costPerToken as string | null,
        })),
    });
});
```

(No test added — this route has no existing test file, matching the spec's "no precedent to extend" testing decision.)

- [ ] **Step 2: Type-check**

Run: `cd products/agent-platform/packages/api && pnpm exec tsc --noEmit 2>&1 | grep -i llm-providers`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add products/agent-platform/packages/api/routes/llm-providers.ts
git commit -m "feat(agent-platform-api): expose costPerToken from GET /llm-providers"
```

---

### Task 7: Seed curated OpenRouter provider rows

**Files:**
- Create: `products/agent-platform/packages/api/seeds/llm-providers-openrouter.ts`
- Modify: `products/agent-platform/packages/api/package.json`

**Interfaces:**
- Consumes: `llmProviders` table shape (existing schema) via raw `postgres` client, matching `seeds/agent-templates.ts`'s pattern.
- Produces: 3 rows in `llm_providers` with `isPlatform: true`, `tenantId: null`, `status: 'coming_soon'` — consumed by the frontend picker (Task 8/9) once queried via `GET /llm-providers`.

- [ ] **Step 1: Write the seed script**

Create `products/agent-platform/packages/api/seeds/llm-providers-openrouter.ts`:

```typescript
/**
 * Seeds 3 curated OpenRouter-backed model rows for the chat model picker.
 *
 * Shipped as status: 'coming_soon' — there is no real OPENROUTER_API_KEY configured
 * yet (see apps/inference-gateway/.env.example). Flipping a row to 'live' once a key
 * is added is a one-row UPDATE, not a re-seed:
 *   UPDATE llm_providers SET status = 'live' WHERE provider = 'openrouter' AND model = '<model>';
 *
 * Model slugs are best-effort based on OpenRouter's vendor/model naming convention and
 * should be verified against OpenRouter's live catalog before flipping to 'live'.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:llm-providers-openrouter
 */

import postgres from 'postgres';

interface SeedRow {
  provider: 'openrouter';
  model: string;
  displayName: string;
  costPerToken: string; // relative ordering matters more than the exact value — see design doc
}

const ROWS: SeedRow[] = [
  { provider: 'openrouter', model: 'anthropic/claude-opus-5', displayName: 'Claude Opus 5', costPerToken: '0.00007500' },
  { provider: 'openrouter', model: 'openai/gpt-5.1', displayName: 'GPT-5.1', costPerToken: '0.00003000' },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash (OpenRouter)', costPerToken: '0.00000500' },
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    for (const row of ROWS) {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM llm_providers
        WHERE provider = ${row.provider} AND model = ${row.model} AND is_platform = true
        LIMIT 1
      `;

      if (existing) {
        await sql`
          UPDATE llm_providers
          SET display_name = ${row.displayName}, cost_per_token = ${row.costPerToken}
          WHERE id = ${existing.id}
        `;
        console.log(`[seed:llm-providers-openrouter] updated ${row.displayName}`);
        continue;
      }

      await sql`
        INSERT INTO llm_providers (tenant_id, provider, model, api_key_encrypted, is_default, cost_per_token, display_name, is_platform, status)
        VALUES (
          NULL,
          ${row.provider},
          ${row.model},
          '',
          false,
          ${row.costPerToken},
          ${row.displayName},
          true,
          'coming_soon'
        )
      `;
      console.log(`[seed:llm-providers-openrouter] inserted ${row.displayName}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:llm-providers-openrouter] failed', err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm script**

In `products/agent-platform/packages/api/package.json`, add to `scripts` (next to `db:seed:templates`/`db:seed:personas`):

```json
    "db:seed:llm-providers-openrouter": "tsx seeds/llm-providers-openrouter.ts",
```

- [ ] **Step 3: Run it against the dev database**

Run: `cd products/agent-platform/packages/api && DATABASE_URL='<dev DATABASE_URL from apps/api/.env>' pnpm db:seed:llm-providers-openrouter`
Expected: 3 lines of `[seed:llm-providers-openrouter] inserted ...` output, no errors.

- [ ] **Step 4: Verify the rows landed**

Run:
```bash
DATABASE_URL='<dev DATABASE_URL>' node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
sql\`SELECT display_name, provider, model, status FROM llm_providers WHERE provider = 'openrouter'\`.then(r => { console.log(r); return sql.end(); });
"
```
Expected: 3 rows, all with `status: 'coming_soon'`.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/seeds/llm-providers-openrouter.ts products/agent-platform/packages/api/package.json
git commit -m "feat(agent-platform-api): seed curated OpenRouter model rows"
```

---

### Task 8: Add `costPerToken` to the frontend provider type

**Files:**
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatPage.ts`
- Modify: `apps/web/components/platform/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: `costPerToken` field on `GET /llm-providers` response (Task 6).
- Produces: `LLMProvider.costPerToken: string | null` in both files' local interfaces — consumed by Task 9's picker rendering.

- [ ] **Step 1: Update `useChatPage.ts`**

In `apps/web/app/[tenant]/dashboard/chat/useChatPage.ts`, update the local interface:

```typescript
interface LLMProvider {
    id: string; provider: string; model: string;
    displayName: string; isDefault: boolean;
    status: 'live' | 'coming_soon';
    costPerToken: string | null;
}
```

- [ ] **Step 2: Update `ChatInput.tsx`**

In `apps/web/components/platform/chat/ChatInput.tsx`, update the local interface (same shape as `useChatPage.ts`'s — both files already independently declare this type, matching the existing pattern where `Agent`/`LLMProvider` shapes are locally duplicated rather than centrally shared):

```typescript
interface LLMProvider {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    status: 'live' | 'coming_soon';
    costPerToken: string | null;
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit 2>&1 | grep -i "useChatPage.ts\|ChatInput.tsx"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/\[tenant\]/dashboard/chat/useChatPage.ts apps/web/components/platform/chat/ChatInput.tsx
git commit -m "feat(web): add costPerToken to the LLMProvider type"
```

---

### Task 9: Render the model picker in ChatInput

**Files:**
- Modify: `apps/web/components/platform/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: `providers`, `llmProviderId`, `onModelChange` props (already exist on `ChatInputProps`, already passed in from `apps/web/app/[tenant]/dashboard/chat/page.tsx` — no caller changes needed).
- Produces: a rendered dropdown; no new exports.

- [ ] **Step 1: Add the cost-tier ranking helper**

In `apps/web/components/platform/chat/ChatInput.tsx`, add near the top of the file (after the `LLMProvider` interface from Task 8):

```typescript
// Ranks providers by costPerToken into thirds for a relative $ / $$ / $$$ badge —
// no hardcoded dollar thresholds, since costPerToken values will shift as models are
// added/removed from the picker. Providers with no costPerToken get no badge.
function costTierBadges(providers: LLMProvider[]): Map<string, string> {
    const withCost = providers
        .filter((p): p is LLMProvider & { costPerToken: string } => p.costPerToken !== null)
        .map(p => ({ id: p.id, cost: parseFloat(p.costPerToken) }))
        .sort((a, b) => a.cost - b.cost);

    const badges = new Map<string, string>();
    const n = withCost.length;
    withCost.forEach((p, i) => {
        const tier = n <= 1 ? 1 : Math.floor((i / n) * 3);
        badges.set(p.id, '$'.repeat(Math.min(tier + 1, 3)));
    });
    return badges;
}
```

- [ ] **Step 2: Render the trigger + dropdown**

In the JSX, find the "Use employee" button (the `<button type="button" onClick={handleUseEmployee} ...>` block). Add a new `DropdownMenu` immediately after its closing `</button>`, still inside the same `<div className="flex items-center gap-0.5">` wrapper:

```tsx
                                    <button
                                        type="button"
                                        onClick={handleUseEmployee}
                                        className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                                            <rect x="3" y="5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                                            <circle cx="5.5" cy="8" r="0.6" fill="currentColor"/>
                                            <circle cx="8.5" cy="8" r="0.6" fill="currentColor"/>
                                            <line x1="7" y1="5" x2="7" y2="3.2" stroke="currentColor" strokeWidth="1"/>
                                            <circle cx="7" cy="2.6" r="0.6" fill="currentColor"/>
                                        </svg>
                                        Use employee
                                    </button>

                                    {providers && providers.length > 0 && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                                >
                                                    {providers.find(p => p.id === llmProviderId)?.displayName ?? 'Model'}
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent side="top" align="start" className="w-56 p-2">
                                                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Model</div>
                                                {(() => {
                                                    const badges = costTierBadges(providers);
                                                    return providers.map(provider => (
                                                        <DropdownMenuItem
                                                            key={provider.id}
                                                            disabled={provider.status !== 'live'}
                                                            onClick={() => onModelChange?.(provider.id)}
                                                            className="flex items-center justify-between gap-2 cursor-pointer py-2"
                                                        >
                                                            <span>{provider.displayName}</span>
                                                            <span className="text-[10px] text-muted-foreground">
                                                                {provider.status !== 'live' ? 'Coming soon' : badges.get(provider.id) ?? ''}
                                                            </span>
                                                        </DropdownMenuItem>
                                                    ));
                                                })()}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit 2>&1 | grep -i "ChatInput.tsx"`
Expected: no output.

- [ ] **Step 4: Manual verification**

Run: `cd apps/web && pnpm dev`, open the chat page in a browser, and confirm:
- A "Model" (or the default provider's `displayName`) button appears next to "Use employee".
- Clicking it opens a dropdown listing all `providers`, each with a cost badge or "Coming soon".
- The 3 seeded OpenRouter rows (Task 7) show "Coming soon" and are not clickable.
- Selecting a `live` provider closes the dropdown and persists (verify via the Network tab: a `PATCH` to the agent's endpoint fires with the new `llmProviderId`, matching the existing `updateAgentMutation` wiring in `useChatPage.ts` — unchanged by this task).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/chat/ChatInput.tsx
git commit -m "feat(web): render the model picker in ChatInput"
```
