# Director Agent — Image Generation & Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new official agent, "Director," that generates and edits images via Gemini 3 Pro Image (`gemini-3-pro-image-preview`), synchronously, inline in chat, charged at actual per-call cost.

**Architecture:** A new `/v1/images/generations` route on the inference gateway wraps Vertex/Gemini's native image-generation call (no fit in the existing OpenAI-chat-completions wire format). Two new Mastra tools (`generateImage`, `editImage`) call that route, charge credits directly via `spendCredits` before generating, upload the result through a generalized `uploadGeneratedFile`, and return attachment metadata only (never bytes) to the agent. `chatStream.ts` is extended to recognize these tool results as attachments. Director is seeded into all four places the codebase currently defines default agents/personas.

**Tech Stack:** Mastra (`@mastra/core`), Gemini 3 Pro Image via Vertex AI (`@google-cloud/vertexai` REST, ADC) with Gemini API-key fallback, Drizzle/Postgres, `@serverless-saas/credits`.

**Spec:** `docs/superpowers/specs/2026-09-01-director-agent-image-generation-design.md`

## Global Constraints

- Image model: `gemini-3-pro-image-preview` — never fall back to Ollama for this model (§4 of spec).
- Tool outputs never carry image bytes back into the Mastra message history — metadata only (`fileId`, `name`, `fileType`, `size`) (§3).
- Every image generation/edit is charged via a dedicated `image_generation` credit rate, charged before the Gemini call and refunded on failure after charge — never routed through `debitChatTurn` (§6).
- A Gemini safety refusal is never charged and never retried (§3, §6).
- Gateway fetch from the tool carries `AbortSignal.timeout(90_000)`, at most one retry on transient failure only (§3, §7).
- Director is added to all four agent/persona definition sites: `personas.ts` seed, `onboarding.ts`, `backfill-agents.ts`, `registry.ts` (§1).

---

### Task 1: `image_generation` credit rate

**Files:**
- Modify: `packages/foundation/database/schema/credits.ts:17-19`
- Create: migration via `drizzle-kit generate` (output path assigned by the tool)
- Test: `packages/foundation/credits/src/rate.test.ts` (create if it doesn't exist, else extend)

**Interfaces:**
- Produces: `creditRates.resourceType` now accepts `'image_generation'` as a valid enum value, usable by `resolveRate('image_generation', 'gemini-3-pro-image-preview')` (existing function, `packages/foundation/credits/src/read.ts:83`).

- [ ] **Step 1: Write the failing test — `per_call_micro` schema resolves for the new resource type**

```ts
// packages/foundation/credits/src/rate.test.ts
import { describe, it, expect } from 'vitest'
import { costMicro } from './rate'

describe('costMicro — per_call_micro (image generation)', () => {
  it('charges the flat per-call rate once, ignoring token usage fields', () => {
    const schema = { per_call_micro: 50_000 } as const
    expect(costMicro(schema, { count: 1 })).toBe(50_000n)
  })

  it('returns 0 when count is 0 (e.g. a dry-run resolve)', () => {
    const schema = { per_call_micro: 50_000 } as const
    expect(costMicro(schema, { count: 0 })).toBe(0n)
  })
})
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `pnpm --filter @serverless-saas/credits test rate.test.ts`
Expected: PASS — `costMicro`'s `per_call_micro` branch already exists (`rate.ts:24-28`); this step proves the pricing math needs no change, only the resource-type enum does.

- [ ] **Step 3: Add `image_generation` to the schema enum**

Edit `packages/foundation/database/schema/credits.ts:17-19`:

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation'],
  }).notNull(),
```

- [ ] **Step 4: Generate and review the migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`
Expected: a new migration file; since `resourceType` is a plain `text` column (not a Postgres `pgEnum`), this generates as effectively a no-op DDL — TypeScript-level typing only changes. Confirm no destructive DDL is in the generated file before committing it.

- [ ] **Step 5: Apply the migration to the dev database**

Run: `cd packages/foundation/database && DATABASE_URL=<dev-url> pnpm exec drizzle-kit migrate`

- [ ] **Step 6: Seed the dev rate row**

Run (adjust `<rate-owner-decision>` once pricing is decided — flagged open in the spec, §6):

```sql
insert into credit_rates (resource_type, subject, version, pricing_schema, is_active)
values ('image_generation', 'gemini-3-pro-image-preview', 1, '{"per_call_micro": 50000}'::jsonb, true);
```

- [ ] **Step 7: Commit**

```bash
git add packages/foundation/database/schema/credits.ts packages/foundation/database/migrations packages/foundation/credits/src/rate.test.ts
git commit -m "feat(credits): add image_generation resource type for per-image charges"
```

---

### Task 2: Generalize `uploadGeneratedFile` for binary content

**Files:**
- Modify: `apps/agent-orchestrator/src/persistence.ts:227-308`
- Test: `apps/agent-orchestrator/src/persistence.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: `uploadGeneratedFile(idToken, { conversationId, title, content, contentType?, extension? }): Promise<AttachmentPayload | null>` — `content` now accepts `string | Buffer`; `contentType` defaults `'text/markdown'`, `extension` defaults `'md'`. `AttachmentPayload` unchanged (`{ fileId, name, type, size }`). `generatedFileKey(conversationId, title, extension?)` — `extension` defaults `'md'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/persistence.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatedFileKey, uploadGeneratedFile } from './persistence'

describe('generatedFileKey', () => {
  it('uses the given extension instead of always .md', () => {
    const key = generatedFileKey('conv-1', 'A Generated Image', 'png')
    expect(key).toMatch(/^generated\/conv-1\/.+-a-generated-image\.png$/)
  })

  it('defaults to .md when no extension is given', () => {
    const key = generatedFileKey('conv-1', 'A Doc')
    expect(key).toMatch(/\.md$/)
  })
})

describe('uploadGeneratedFile — binary content', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('uploads a Buffer with the given contentType and byte size, not string length', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]) // fake JPEG magic bytes
    const calls: Array<{ url: string; init?: RequestInit }> = []
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/files/upload')) {
        return new Response(JSON.stringify({ data: { fileId: 'f1', uploadUrl: 'https://s3.example/put' } }), { status: 200 })
      }
      if (String(url) === 'https://s3.example/put') {
        return new Response(null, { status: 200 })
      }
      if (String(url).endsWith('/confirm')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      throw new Error('unexpected fetch: ' + url)
    }) as unknown as typeof fetch

    const result = await uploadGeneratedFile('tok', {
      conversationId: 'conv-1',
      title: 'Generated Image',
      content: buf,
      contentType: 'image/jpeg',
      extension: 'jpg',
    })

    expect(result).toEqual({ fileId: 'f1', name: 'Generated Image.jpg', type: 'image/jpeg', size: buf.length })
    const putCall = calls.find(c => c.url === 'https://s3.example/put')
    expect(putCall?.init?.body).toBe(buf)
    expect((putCall?.init?.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test persistence.test.ts`
Expected: FAIL — `generatedFileKey` has no third parameter, `uploadGeneratedFile` hardcodes `.md`/`text/markdown`/`Buffer.byteLength(content)` on a string.

- [ ] **Step 3: Implement**

Replace `apps/agent-orchestrator/src/persistence.ts:227-308`:

```ts
export function generatedFileKey(conversationId: string, title: string, extension = 'md'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `generated/${conversationId}/${randomUUID()}-${slug || 'document'}.${extension}`
}

export async function uploadGeneratedFile(
  idToken: string,
  input: {
    conversationId: string
    title: string
    content: string | Buffer
    contentType?: string
    extension?: string
  },
): Promise<AttachmentPayload | null> {
  const { conversationId, title, content } = input
  const type = input.contentType ?? 'text/markdown'
  const extension = input.extension ?? 'md'
  const name = `${title}.${extension}`
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content)

  try {
    const res = await fetch(`${API_BASE}/api/v1/files/upload`, {
      method: 'POST',
      headers: authHeaders(idToken),
      body: JSON.stringify({
        filename: name,
        contentType: type,
        key: generatedFileKey(conversationId, title, extension),
        size,
      }),
    })
    if (!res.ok) {
      console.error('[persistence] uploadGeneratedFile /upload failed:', res.status, await res.text().catch(() => ''))
      return null
    }
    const json = await res.json() as { data?: { fileId?: string; uploadUrl?: string } }
    const fileId = json.data?.fileId
    const uploadUrl = json.data?.uploadUrl
    if (!fileId || !uploadUrl) {
      console.error('[persistence] uploadGeneratedFile: missing fileId/uploadUrl in response')
      return null
    }

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: content,
    })
    if (!put.ok) {
      console.error('[persistence] uploadGeneratedFile PUT failed:', put.status)
      return null
    }

    const confirm = await fetch(`${API_BASE}/api/v1/files/${fileId}/confirm`, {
      method: 'POST',
      headers: authHeaders(idToken),
      body: JSON.stringify({ size }),
    })
    if (!confirm.ok) {
      console.error('[persistence] uploadGeneratedFile /confirm failed:', confirm.status, await confirm.text().catch(() => ''))
      return null
    }

    return { fileId, name, type, size }
  } catch (err) {
    console.error('[persistence] uploadGeneratedFile error:', (err as Error).message)
    return null
  }
}
```

(Every other call site — `renderCanvas.ts` — calls this with only `{ conversationId, title, content }`, a string; `contentType`/`extension` default exactly to today's behavior, so no other file changes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test persistence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/persistence.test.ts
git commit -m "feat(orchestrator): generalize uploadGeneratedFile for binary content"
```

---

### Task 3: Inference gateway — `/v1/images/generations` route

**Files:**
- Modify: `apps/inference-gateway/src/index.ts`
- Modify: `apps/inference-gateway/src/router.ts:49-59`
- Create: `apps/inference-gateway/src/images.ts`
- Test: `apps/inference-gateway/src/images.test.ts`

**Interfaces:**
- Produces: `POST /v1/images/generations` — request body
  `{ model: string, prompt: string, sourceImageBase64?: string, sourceMimeType?: string }`,
  response `{ imageBase64: string, mimeType: string } | { refused: true, reason: string }`
  on 200; `{ error: { message, type } }` on failure status.
- Produces: `getImageAdapterChain(model): ('vertex' | 'gemini')[]` in `router.ts` — ordered adapter names to try, no Ollama.
- Consumes: `_auth` (`GoogleAuth`) pattern already in `index.ts:23` for Vertex ADC.

- [ ] **Step 1: Write the failing test — refusal classification is a normal response, not a thrown error**

```ts
// apps/inference-gateway/src/images.test.ts
import { describe, it, expect, vi } from 'vitest'
import { classifyGeminiImageResponse } from './images'

describe('classifyGeminiImageResponse', () => {
  it('extracts inline image bytes from a normal candidate', () => {
    const geminiResponse = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
      }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      imageBase64: 'QUJD',
      mimeType: 'image/png',
    })
  })

  it('classifies a SAFETY finishReason as a refusal, not a throw', () => {
    const geminiResponse = {
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    }
    expect(classifyGeminiImageResponse(geminiResponse)).toEqual({
      refused: true,
      reason: 'SAFETY',
    })
  })

  it('classifies an empty candidate list as a refusal', () => {
    expect(classifyGeminiImageResponse({ candidates: [] })).toEqual({
      refused: true,
      reason: 'NO_CANDIDATES',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter inference-gateway test images.test.ts`
Expected: FAIL — `./images.ts` does not exist yet.

- [ ] **Step 3: Implement `images.ts`**

```ts
// apps/inference-gateway/src/images.ts
import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'

const IMAGE_MODEL_ALLOWLIST = new Set(['gemini-3-pro-image-preview'])

const PROJECT = process.env.VERTEX_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

// Business/policy decision, not an engineering default — see spec §4.
// BLOCK_MEDIUM_AND_ABOVE chosen as a conservative starting point; revisit
// with whoever owns content policy before this ships broadly.
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
]

export interface ImageGenerationRequest {
  model: string
  prompt: string
  sourceImageBase64?: string
  sourceMimeType?: string
}

export type ImageGenerationResult =
  | { imageBase64: string; mimeType: string }
  | { refused: true; reason: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyGeminiImageResponse(geminiResponse: any): ImageGenerationResult {
  const candidate = geminiResponse?.candidates?.[0]
  if (!candidate) return { refused: true, reason: 'NO_CANDIDATES' }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    return { refused: true, reason: candidate.finishReason }
  }
  const parts: Array<{ inlineData?: { mimeType: string; data: string } }> = candidate.content?.parts ?? []
  const imagePart = parts.find(p => p.inlineData)
  if (!imagePart?.inlineData) return { refused: true, reason: 'NO_IMAGE_PART' }
  return { imageBase64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType }
}

function buildGeminiImageRequest(req: ImageGenerationRequest) {
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }]
  if (req.sourceImageBase64 && req.sourceMimeType) {
    parts.push({ inlineData: { mimeType: req.sourceMimeType, data: req.sourceImageBase64 } })
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
    safetySettings: SAFETY_SETTINGS,
  }
}

async function callVertexImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${req.model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiImageRequest(req)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Vertex image generation failed: ${res.status} ${await res.text()}`)
  return classifyGeminiImageResponse(await res.json())
}

async function callGeminiApiKeyImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiImageRequest(req)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Gemini API image generation failed: ${res.status} ${await res.text()}`)
  return classifyGeminiImageResponse(await res.json())
}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  if (!IMAGE_MODEL_ALLOWLIST.has(req.model)) {
    throw new Error(`Unsupported image model: ${req.model}`)
  }
  try {
    return await callVertexImageModel(req)
  } catch (vertexErr) {
    console.warn('[images] vertex failed, trying gemini API key fallback:', (vertexErr as Error).message)
    if (!process.env.GEMINI_API_KEY) throw vertexErr
    return await callGeminiApiKeyImageModel(req)
  }
}

export async function handleImageGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: ImageGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  try {
    const result = await generateImage(payload)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    console.error('[images] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter inference-gateway test images.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the route into `index.ts` and cap request body size**

Edit `apps/inference-gateway/src/index.ts`:

```ts
import { handleImageGenerations } from './images.js';

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
```

And add the route, after the existing `/v1/chat/completions` block (`index.ts:349-352`):

```ts
  // Image generation (Director agent)
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    await handleImageGenerations(req, res, readBody);
    return;
  }
```

`readBody`'s reject on oversize needs a 413 at each call site that doesn't already have one — `handleImageGenerations` and `handleChatCompletions` both call `readBody` inside a `try { } catch { res.writeHead(400, ...) }`; change both catches to check `err.message === 'PAYLOAD_TOO_LARGE'` and write 413 instead of 400 in that case.

- [ ] **Step 6: No-Ollama chain for image models**

Edit `apps/inference-gateway/src/router.ts`, add alongside `getAdapterChain`:

```ts
const IMAGE_MODELS = new Set(['gemini-3-pro-image-preview']);

/**
 * Image models never fall through to Ollama — Ollama cannot generate images
 * and doesn't recognize the model name. If both Vertex and the Gemini API
 * key fail, the caller gets a clean failure instead of a silent wrong answer.
 */
export function isImageModel(model: string | undefined): boolean {
  return IMAGE_MODELS.has(model ?? '');
}
```

(`images.ts`'s `generateImage` already implements the vertex→gemini-key-only fallback directly, per Step 3 — this export exists so any future caller of `getAdapterChain` can check before routing a request there instead of to `/v1/images/generations`.)

- [ ] **Step 7: Run full gateway test suite**

Run: `pnpm --filter inference-gateway test`
Expected: PASS, no regressions in existing adapter/router tests.

- [ ] **Step 8: Commit**

```bash
git add apps/inference-gateway/src/images.ts apps/inference-gateway/src/images.test.ts apps/inference-gateway/src/index.ts apps/inference-gateway/src/router.ts
git commit -m "feat(inference-gateway): add /v1/images/generations for Gemini 3 Pro Image"
```

---

### Task 4: `generateImage` and `editImage` Mastra tools

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/editImage.ts`
- Modify: `apps/agent-orchestrator/src/media.ts` (add `resolveSourceImage`)
- Test: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/editImage.test.ts`

**Interfaces:**
- Consumes: `uploadGeneratedFile` (Task 2), `spendCredits`/`resolveRate`/`isUnlimited` from `@serverless-saas/credits`, `downloadMediaAttachment` (`media.ts:103`), gateway's `POST /v1/images/generations` (Task 3).
- Produces: `generateImage` and `editImage` — Mastra `createTool()` instances, `outputSchema: { fileId?, name?, fileType?, size?, refused?, refusalReason?, insufficientCredits? }`.

- [ ] **Step 1: Add `resolveSourceImage` to `media.ts`**

`downloadMediaAttachment` (`media.ts:103`) takes a full `Attachment` object with a `presignedUrl` already resolved. `editImage`'s input is just a `fileId` from the conversation — resolve the presigned URL through the existing files route first:

```ts
// apps/agent-orchestrator/src/media.ts — add near downloadMediaAttachment
const API_BASE = process.env.API_BASE_URL ?? ''

export async function resolveSourceImage(
  idToken: string,
  fileId: string,
  mimeType: string,
  sessionId: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/files/${fileId}/presigned-url`, {
      headers: { Authorization: `Bearer ${idToken}` },
    })
    if (!res.ok) {
      console.error(`[session:${sessionId}] resolveSourceImage presigned-url failed:`, res.status)
      return null
    }
    const { presignedUrl } = await res.json() as { presignedUrl?: string }
    if (!presignedUrl) return null
    const downloaded = await downloadMediaAttachment(
      { fileId, presignedUrl, name: fileId, type: mimeType } as Attachment,
      sessionId,
    )
    if (!downloaded || Array.isArray(downloaded)) return null
    const match = downloaded.base64.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    return { base64: match[2], mimeType: match[1] }
  } catch (err) {
    console.error(`[session:${sessionId}] resolveSourceImage error:`, (err as Error).message)
    return null
  }
}
```

(`GET /api/v1/files/:id/presigned-url`, `apps/api/src/routes/files.ts:282`, already scopes to the caller's tenant — no separate tenancy check needed here.)

- [ ] **Step 2: Write the failing test for `generateImage`**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const spendCredits = vi.fn()
const resolveRate = vi.fn()
const isUnlimited = vi.fn()
vi.mock('@serverless-saas/credits', () => ({ spendCredits, resolveRate, isUnlimited }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

import { generateImage } from './generateImage'
import { uploadGeneratedFile } from '../../persistence.js'

function fakeExecContext(overrides: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>({
    tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok', ...overrides,
  })
  return { requestContext: { get: (k: string) => map.get(k) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

describe('generateImage tool', () => {
  it('charges credits, calls the gateway, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute({ prompt: 'a red bicycle' }, fakeExecContext())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -50_000n, kind: 'debit' }))
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3 })
    expect(result).not.toHaveProperty('imageBase64')
  })

  it('does not charge and returns a refusal when Gemini refuses', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'SAFETY' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateImage.execute({ prompt: 'anything' }, fakeExecContext())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'SAFETY' })
  })

  it('returns insufficientCredits without generating when spendCredits throws', async () => {
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))
    global.fetch = vi.fn()

    const result = await generateImage.execute({ prompt: 'anything' }, fakeExecContext())

    expect(global.fetch).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test generateImage.test.ts`
Expected: FAIL — `./generateImage.ts` does not exist.

- [ ] **Step 4: Implement `generateImage.ts`**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateImage.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const IMAGE_MODEL = 'gemini-3-pro-image-preview'

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateImage = createTool({
  id: 'generate-image',
  description: 'Generates a new image from a text prompt using Gemini 3 Pro Image. Use when the user asks Director to create, draw, or generate an image.',
  inputSchema: z.object({
    prompt: z.string().describe('Full description of the image to generate'),
  }),
  outputSchema,
  execute: async (inputData, execContext) => {
    const { prompt } = inputData as { prompt: string }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    const chargeKey = `image:${sessionId}:${Date.now()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let chargedMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('image_generation', IMAGE_MODEL)
      if (rate) {
        rateId = rate.id
        rateVersion = rate.version
        chargedMicro = rate.schema && 'per_call_micro' in rate.schema ? BigInt(rate.schema.per_call_micro) : 0n
        try {
          await spendCredits({
            tenantId, amountMicro: -chargedMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }

    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      const result = await res.json() as { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }

      if (result.refused) {
        if (charged) await refundImageCharge(tenantId, agentId, chargeKey, chargedMicro, rateId, rateVersion)
        return { refused: true, refusalReason: result.reason ?? 'unknown' }
      }

      const buffer = Buffer.from(result.imageBase64!, 'base64')
      const extension = (result.mimeType ?? 'image/png').split('/')[1] ?? 'png'
      const attachment = conversationId && idToken
        ? await uploadGeneratedFile(idToken, {
            conversationId, title: 'Generated Image', content: buffer,
            contentType: result.mimeType, extension,
          })
        : null

      if (!attachment && charged) {
        // Generated and paid for, but couldn't be saved (upload/quota failure) —
        // the user gets nothing back, so refund (spec §5/§6).
        await refundImageCharge(tenantId, agentId, chargeKey, chargedMicro, rateId, rateVersion)
        return { refused: true, refusalReason: 'STORAGE_FAILED' }
      }

      return attachment
        ? { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
        : {}
    } catch (err) {
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, chargedMicro, rateId, rateVersion)
      console.error(`[session:${sessionId}] generateImage failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }
  },
})

// Mirrors settleTask's delta-write pattern (credits.ts:380-402): a positive
// amountMicro credits the tenant back. Full refund of what was charged, keyed
// off the original chargeKey so it's traceable to the debit it reverses.
async function refundImageCharge(
  tenantId: string, agentId: string, chargeKey: string, chargedMicro: bigint,
  rateId: string | null, rateVersion: number | null,
): Promise<void> {
  try {
    await spendCredits({
      tenantId, amountMicro: chargedMicro, key: `${chargeKey}:refund`, kind: 'settle',
      actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
      grantType: 'refund',
    })
  } catch (err) {
    console.error(`[credits] refundImageCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test generateImage.test.ts`
Expected: PASS

- [ ] **Step 6: Write `editImage.ts` and its test, following the same shape**

Same structure as `generateImage`, with:
- `inputSchema: z.object({ prompt: z.string(), sourceFileId: z.string(), sourceMimeType: z.string() })`
- Before charging, call `resolveSourceImage(idToken, sourceFileId, sourceMimeType, sessionId)` (Step 1); if it returns `null`, return `{ refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }` without charging.
- Gateway call body includes `sourceImageBase64`/`sourceMimeType` alongside `prompt`.
- Test file `editImage.test.ts` mirrors `generateImage.test.ts`'s three cases, plus one for `SOURCE_IMAGE_UNAVAILABLE`.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts apps/agent-orchestrator/src/mastra/tools/editImage.ts apps/agent-orchestrator/src/mastra/tools/editImage.test.ts apps/agent-orchestrator/src/media.ts
git commit -m "feat(orchestrator): generateImage/editImage Mastra tools with per-call credit charging"
```

---

### Task 5: `directorAgent` and registry wiring

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`
- Modify: `apps/agent-orchestrator/src/mastra/registry.ts`
- Test: `apps/agent-orchestrator/src/mastra/registry.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `generateImage`, `editImage` (Task 4), `tenantContextSchema` (`../context.js`), `selectModel` (`./modelSelection.js`), `getMastraMemory` (`../memory.js`).
- Produces: `directorAgent: Agent`. `resolveAgent('director')` → `directorAgent`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/registry.test.ts
import { describe, it, expect } from 'vitest'
import { resolveAgent, resolveAgentLabel } from './registry'
import { directorAgent } from './agents/directorAgent.js'

describe('registry — director', () => {
  it('resolves the exact agent name "Director" (lowercased) to directorAgent', () => {
    expect(resolveAgent('Director')).toBe(directorAgent)
  })

  it('labels directorAgent correctly', () => {
    expect(resolveAgentLabel(directorAgent as never)).toBe('directorAgent')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test registry.test.ts`
Expected: FAIL — `directorAgent.ts` doesn't exist, `'director'` isn't in `AGENT_REGISTRY`.

- [ ] **Step 3: Implement `directorAgent.ts`**

```ts
import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { tenantContextSchema } from '../context.js'
import { selectModel } from './modelSelection.js'
import { getMastraMemory } from '../memory.js'
import { generateImage } from '../tools/generateImage.js'
import { editImage } from '../tools/editImage.js'

export const directorAgent = new Agent({
  id: 'pc-director',
  name: 'Director',
  description: 'Generates and edits images from a text description.',
  instructions: async ({ requestContext }: { requestContext?: RequestContext }) => {
    const base = `You are Director — an image generation specialist. You create and edit images from descriptions.

## Rules
- Call generate-image for a new image from a text description.
- Call edit-image when the user references an existing image in this conversation (by its fileId) and wants it changed.
- If a generation is refused (returns refused: true), tell the user plainly what happened — do not retry automatically, do not describe the refusal as an error.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
- Never invent a fileId — only use one the user or an earlier tool result actually gave you.`
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { generateImage, editImage },
})
```

- [ ] **Step 4: Wire into `registry.ts`**

```ts
import { directorAgent } from './agents/directorAgent.js'

const AGENT_REGISTRY: Record<string, Agent> = {
  disco:      platformAgent as unknown as Agent,
  'pm agent': pmAgent as unknown as Agent,
  architect:  architectAgent as unknown as Agent,
  director:   directorAgent as unknown as Agent,
}
```

```ts
export function resolveAgentLabel(agent: Agent): string {
  if (agent === (architectAgent as unknown as Agent)) return 'architectAgent'
  if (agent === (pmAgent as unknown as Agent)) return 'pmAgent'
  if (agent === (directorAgent as unknown as Agent)) return 'directorAgent'
  return 'platformAgent'
}
```

Also correct the stale comment at `registry.ts:35-36` ("Consumed by onboarding + backfill scripts") — `DEFAULT_AGENTS` in this file is not what `onboarding.ts` actually seeds from (Task 7 confirms and fixes this properly); replace with:

```ts
// Display-only default agent list. NOT what onboarding.ts seeds from — that
// file hand-rolls its own agent rows (Lambda can't import this file). Keep
// this list in sync with onboarding.ts and backfill-agents.ts by hand.
export const DEFAULT_AGENTS = [
```

Add a "Director" entry to that array too, for consistency with the other three:

```ts
  {
    name: 'Director',
    description: 'Generates and edits images',
    type: 'assistant',
    status: 'active',
    is_internal: false,
    apiKeyName: 'Director API Key',
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/registry.ts apps/agent-orchestrator/src/mastra/registry.test.ts
git commit -m "feat(orchestrator): add directorAgent and wire into the agent registry"
```

---

### Task 6: `chatStream.ts` attachment delivery

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:129-141, 209`
- Test: `apps/agent-orchestrator/src/routes/chatStream.test.ts` (extend existing tool-result handling tests)

**Interfaces:**
- Consumes: tool results from `generate-image`/`edit-image` (Task 4's output shape).
- Produces: same attachment delivery path `render-canvas` already uses, now shared by three tool names.

- [ ] **Step 1: Write the failing test**

The gate lives in the exported, pure function `attachmentFromCanvasToolResult` (`chatStream.ts:127-139`):

```ts
export function attachmentFromCanvasToolResult(
  normalizedToolName: string,
  result: Record<string, unknown>,
): AttachmentPayload | null {
  if (normalizedToolName !== 'render-canvas') return null
  if (typeof result.fileId !== 'string') return null
  return {
    fileId: result.fileId,
    name: String(result.name ?? 'document.md'),
    type: String(result.fileType ?? 'text/markdown'),
    size: typeof result.size === 'number' ? result.size : 0,
  }
}
```

Add to `chatStream.test.ts`:

```ts
import { attachmentFromCanvasToolResult } from './chatStream'

describe('attachmentFromCanvasToolResult — generate-image/edit-image', () => {
  it('turns a generate-image tool result into an attachment, same as render-canvas', () => {
    const result = { fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 100 }
    expect(attachmentFromCanvasToolResult('generate-image', result)).toEqual({
      fileId: 'f1', name: 'x.png', type: 'image/png', size: 100,
    })
  })

  it('turns an edit-image tool result into an attachment', () => {
    const result = { fileId: 'f2', name: 'y.png', fileType: 'image/png', size: 200 }
    expect(attachmentFromCanvasToolResult('edit-image', result)).toEqual({
      fileId: 'f2', name: 'y.png', type: 'image/png', size: 200,
    })
  })

  it('still returns null for an unrelated tool name', () => {
    expect(attachmentFromCanvasToolResult('fetch-agent-context', { fileId: 'f3' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter agent-orchestrator test chatStream.test.ts`
Expected: FAIL — `generate-image`/`edit-image` still return `null` from the gate.

- [ ] **Step 3: Implement**

Edit `chatStream.ts:133`:

```ts
  if (!['render-canvas', 'generate-image', 'edit-image'].includes(normalizedToolName)) return null
```

Edit `chatStream.ts:209`:

```ts
  const SAVE_TOOL_NAMES = new Set([
    'saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks',
    'rendercanvas', 'render-canvas', 'render_canvas',
    'generateimage', 'generate-image', 'generate_image',
    'editimage', 'edit-image', 'edit_image',
  ])
```

Confirm the branch around `chatStream.ts:375` (`if (SAVE_TOOL_NAMES.has(normName) && normName !== 'render-canvas')`) — `generate-image`/`edit-image` should follow the same "no `pendingArtifactRef`" path as `render-canvas` (they're ephemeral display, not a PRD/roadmap/tasks artifact), so extend that condition to exclude all three:

```ts
if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image'].includes(normName)) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test chatStream.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/chatStream.test.ts
git commit -m "feat(orchestrator): deliver generate-image/edit-image results as chat attachments"
```

---

### Task 7: Seed Director across all four agent/persona rosters

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/personas.ts:10-32`
- Modify: `apps/api/src/routes/onboarding.ts` (after the Architect block, ~line 339 onward)
- Modify: `packages/foundation/database/seeds/backfill-agents.ts:53+`

**Interfaces:**
- Consumes: `DEFAULT_PERSONAS` shape (`personas.ts:10-32`), onboarding's inline agent-seeding pattern (`onboarding.ts:170-192`), `backfill-agents.ts`'s `DEFAULT_AGENTS` shape.
- Produces: a `director` persona row (`is_official: true`, `status: 'draft'`), a `Director` agent row per tenant with `personaId` set to that persona's id.

- [ ] **Step 1: Add the Director persona to `personas.ts`**

```ts
  {
    slug: 'director',
    name: 'Director',
    tagline: 'Generates and edits images from a description.',
    basePersonality: 'You think visually: you turn a rough description into a concrete image brief, ask what changes when a result misses the mark, and never claim an image exists until the generation actually succeeds.',
    skillTags: ['image-generation', 'image-editing'],
  },
```

- [ ] **Step 2: Fetch the Director persona's id inside `onboarding.ts`, seed the agent, and link `personaId`**

Following the exact pattern at `onboarding.ts:170-192` (Research Engineer) — after the Architect block, add:

```ts
    const [directorPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'director')).limit(1);

    const directorRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const directorKeyHash = createHash('sha256').update(directorRawKey).digest('hex');
    const [directorKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Director API Key',
        type: 'agent',
        keyHash: directorKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [directorAgentRow] = await db.insert(agents).values({
        tenantId,
        name: 'Director',
        type: 'assistant',
        status: 'active',
        description: 'Generates and edits images from a description.',
        apiKeyId: directorKey.id,
        personaId: directorPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: directorAgentRow.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are Director. Generate and edit images from a description.',
        tools: [],
        status: 'active',
    });
```

(Import `personas` from wherever `agents`/`agentSkills` are imported in this file — confirm the exact import path while implementing; it is the same schema package `onboarding.ts` already pulls `agents`/`apiKeys` from.) The `personas` seed (Step 1) must have already run against the target database before onboarding creates new tenants, or `directorPersona` resolves to `undefined` and the agent is created with `personaId: null` — acceptable as a non-fatal fallback (matches the existing gap this spec chose not to fix generally), but log a warning in that branch so it's visible in ops if the seed step is ever skipped.

- [ ] **Step 3: Add Director to `backfill-agents.ts`**

```ts
const DEFAULT_AGENTS: { name: string; description: string; systemPrompt: string }[] = [
    {
        name: 'PM Agent',
        description: 'PM supervisor that orchestrates PRD generation, roadmap planning, and task breakdown.',
        systemPrompt: 'You are a PM Agent that helps with product planning, PRDs, roadmaps, and task breakdowns.',
    },
    // ... existing entries unchanged ...
    {
        name: 'Director',
        description: 'Generates and edits images from a description.',
        systemPrompt: 'You are Director. Generate and edit images from a description.',
    },
];
```

- [ ] **Step 4: Manual verification (no automated test — these are seed/onboarding scripts run against a real DB)**

Run the personas seed against dev, then run onboarding for a fresh test tenant, then confirm:

```bash
pnpm --filter @serverless-saas/agent-api db:seed:personas
```

Query: `select id, slug, status from personas where slug = 'director';` → one row, `status = 'draft'`.

Create a test tenant through the normal signup flow, then: `select name, type, persona_id from agents where tenant_id = '<test-tenant-id>' and name = 'Director';` → one row, `persona_id` matching the persona's id from the previous query.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/seeds/personas.ts apps/api/src/routes/onboarding.ts packages/foundation/database/seeds/backfill-agents.ts
git commit -m "feat(agent-platform): seed Director persona and agent across onboarding, backfill, and personas seed"
```

---

### Task 8: Deploy and publish

Not code — operational steps, in order:

- [ ] **Step 1:** Rebuild and deploy the Lambda: `sam build --config-file samconfig.dev.toml && sam deploy --config-file samconfig.dev.toml` (picks up the `onboarding.ts` change from Task 7 — rebuild `packages/foundation/*`/product `dist/` first per the known stale-`dist/` footgun).
- [ ] **Step 2:** Restart the orchestrator: `pm2 restart agent-orchestrator` (picks up Tasks 2, 4, 5, 6).
- [ ] **Step 3:** Restart the inference gateway: `pm2 restart inference-gateway` (picks up Task 3).
- [ ] **Step 4:** Run the personas seed and backfill script against dev (Task 7, Step 4 commands) so existing tenants get Director too, not just new signups.
- [ ] **Step 5:** Publish the Director persona: attach a real preview image via `PUT /ops/personas/:id` (ops portal), then `POST /ops/personas/:id/publish` — required before Director is selectable in the roster (spec §1; the `INCOMPLETE_ASSETS` gate rejects publish without a real `exampleAssetUrl`, `PersonaAvatar`'s generated SVG does not satisfy it).
- [ ] **Step 6:** Manual smoke test: start a chat with Director, ask for an image, confirm it appears as an attachment and the `image_generation` credit charge lands in `credit_ledger`. Ask for an edit referencing the first image's `fileId`. Then send a prompt expected to trigger a safety refusal and confirm no charge lands.
