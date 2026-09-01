# Director Agent — Image Generation & Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new official agent, "Director," that generates and edits images via Gemini 3 Pro Image (`gemini-3-pro-image-preview`), synchronously, inline in chat, charged at actual per-call cost.

**Architecture:** A new `/v1/images/generations` route on the inference gateway wraps Vertex/Gemini's native image-generation call (no fit in the existing OpenAI-chat-completions wire format). Two new Mastra tools (`generateImage`, `editImage`) call that route, charge credits directly via `spendCredits` before generating, upload the result through a generalized `uploadGeneratedFile`, and return attachment metadata only (never bytes) to the agent. `chatStream.ts` is extended to recognize these tool results as attachments. Director is seeded into all four places the codebase currently defines default agents/personas.

**Tech Stack:** Mastra (`@mastra/core`), Gemini 3 Pro Image via Vertex AI (`@google-cloud/vertexai` REST, ADC) with Gemini API-key fallback, Drizzle/Postgres, `@serverless-saas/credits`.

**Spec:** `docs/superpowers/specs/2026-09-01-director-agent-image-generation-design.md`

## Global Constraints

- Image model: `gemini-3-pro-image-preview` — never fall back to Ollama for this model (§4 of spec).
- Tool outputs never carry image bytes back into the Mastra message history — metadata only (`fileId`, `name`, `fileType`, `size`) (§3).
- Every image generation/edit is charged via a dedicated `image_generation` credit rate, charged **after** a successful (non-refused) Gemini response and refunded if the subsequent upload fails — never routed through `debitChatTurn` (§6, spec's charge-after-success default).
- A Gemini safety refusal is never charged and never retried (§3, §6).
- A refund always reads back the original debit's grant(s) from `credit_ledger`/`credit_grants` and inherits their shortest `expires_at` (never a bare/permanent grant) — same pattern as `refundTask` (`products/agent-platform/packages/credits/refund.ts:109-169`).
- Mastra tool keys (the property name in `tools: {...}`, not `createTool`'s `id`) must be `generate_image`/`edit_image` — `chatStream.ts` normalizes on the registered key, not the id (see Task 5, Task 6).
- Gateway fetch from the tool carries `AbortSignal.timeout(90_000)`. No retry loop — a failure returns `GENERATION_FAILED` to the agent, which can re-invoke the tool itself if the user asks again (§3, §7 permit "at most one retry"; this plan ships zero rather than add a retry ladder for a first version).
- Director is added to all four agent/persona definition sites: `personas.ts` seed, `onboarding.ts`, `backfill-agents.ts`, `registry.ts` (§1).

---

### Task 1: `image_generation` credit rate

**Files:**
- Modify: `packages/foundation/database/schema/credits.ts:17-19`
- Create: migration via `drizzle-kit generate` (output path assigned by the tool)

**Interfaces:**
- Produces: `creditRates.resourceType` now accepts `'image_generation'` as a valid enum value, usable by `resolveRate('image_generation', 'gemini-3-pro-image-preview')` (existing function, `packages/foundation/credits/src/read.ts:83`).

- [ ] **Step 1: Confirm `costMicro`'s `per_call_micro` schema needs no change**

The real test file is `packages/foundation/credits/src/__tests__/rate.test.ts` (not `rate.test.ts` at the package root) and it already asserts `costMicro({ per_call_micro: 0 }, { count: 7 })).toBe(0n)`, proving the `per_call_micro` branch (`rate.ts:24-28`) is already exercised. No new test needed here — this task only widens the `resourceType` enum, it doesn't touch pricing math.

Run: `pnpm --filter @serverless-saas/credits test` to confirm the existing suite passes before touching the schema.

- [ ] **Step 2: Add `image_generation` to the schema enum**

Edit `packages/foundation/database/schema/credits.ts:17-19`:

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation'],
  }).notNull(),
```

- [ ] **Step 3: Attempt to generate a migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`
Expected: since `resourceType` is a plain `text` column with a TS-level `enum` option (not a Postgres `pgEnum` type), this most likely reports "No schema changes" and writes no file — the widening is TypeScript-only. If it does emit a file, confirm it contains no destructive DDL before committing it; if it emits nothing, there is nothing to commit for this step and Step 4 is a no-op you can skip.

- [ ] **Step 4: Apply the migration to the dev database (only if Step 3 produced one)**

Run: `cd packages/foundation/database && DATABASE_URL=<dev-url> pnpm exec drizzle-kit migrate`

- [ ] **Step 5: Seed the dev rate row**

Run (adjust the rate value once pricing is decided — flagged open in the spec, §6):

```sql
insert into credit_rates (resource_type, subject, version, pricing_schema, is_active)
values ('image_generation', 'gemini-3-pro-image-preview', 1, '{"per_call_micro": 50000}'::jsonb, true);
```

- [ ] **Step 6: Commit**

```bash
git add packages/foundation/database/schema/credits.ts packages/foundation/database/migrations
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
import { describe, it, expect, vi, afterEach } from 'vitest'
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
- Create: `apps/inference-gateway/src/images.ts` (imports `vertexBreaker`/`geminiBreaker` from `router.ts` — no `router.ts` edits needed, they're already exported)
- Test: `apps/inference-gateway/src/images.test.ts`

**Interfaces:**
- Produces: `POST /v1/images/generations` — request body
  `{ model: string, prompt: string, sourceImageBase64?: string, sourceMimeType?: string }`,
  response `{ imageBase64: string, mimeType: string } | { refused: true, reason: string }`
  on 200; `{ error: { message, type } }` on failure status.
- Consumes: `_auth` (`GoogleAuth`) pattern already in `index.ts:23` for Vertex ADC; `vertexBreaker`/`geminiBreaker` (`router.ts:26,29`) — image generation goes through the same two breakers chat completions use, just never falls through to Ollama.

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
import { vertexBreaker, geminiBreaker } from './router.js'

const IMAGE_MODEL_ALLOWLIST = new Set(['gemini-3-pro-image-preview'])

// Same fallback order index.ts:42 uses for embeddings — VERTEX_PROJECT first,
// GCLOUD_PROJECT second. images.ts previously used VERTEX_PROJECT only, which
// would silently 503 with a malformed URL on a VM where only GCLOUD_PROJECT is set.
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
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

// No Ollama tail here, unlike getAdapterChain's chat-completions chain
// (router.ts:49-58) — Ollama cannot generate images. If both breakers are
// open (or both calls fail), the caller gets a clean throw, handled by
// handleImageGenerations below as a 503.
export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  if (!IMAGE_MODEL_ALLOWLIST.has(req.model)) {
    throw new Error(`Unsupported image model: ${req.model}`)
  }

  if (vertexBreaker.isAvailable()) {
    try {
      const result = await callVertexImageModel(req)
      vertexBreaker.onSuccess()
      return result
    } catch (vertexErr) {
      vertexBreaker.onFailure()
      console.warn('[images] vertex failed, trying gemini API key fallback:', (vertexErr as Error).message)
    }
  } else {
    console.warn('[images] vertex circuit open, trying gemini API key fallback')
  }

  if (!process.env.GEMINI_API_KEY) throw new Error('Vertex image generation unavailable and no GEMINI_API_KEY fallback configured')
  if (!geminiBreaker.isAvailable()) throw new Error('Vertex and Gemini API key both unavailable for image generation')

  try {
    const result = await callGeminiApiKeyImageModel(req)
    geminiBreaker.onSuccess()
    return result
  } catch (geminiErr) {
    geminiBreaker.onFailure()
    throw geminiErr
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

`readBody`'s reject on oversize needs handling at every call site, not just the two with an existing try/catch:

- `handleImageGenerations` and `handleChatCompletions` both already wrap `readBody` in `try { } catch { res.writeHead(400, ...) }` — change both catches to check `err.message === 'PAYLOAD_TOO_LARGE'` and write 413 instead of 400 in that case.
- `handleEmbeddings` (`index.ts:27`) already has a catch too — same fix.
- **`handleNativeGemini` (`index.ts:204`) calls `await readBody(req)` with no try/catch at all.** Today that's harmless because `readBody` never rejects except on a socket error; once it can reject on oversize, an unhandled rejection here means no response is ever written and the client hangs until timeout. Wrap it:

```ts
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
    return;
  }
```

- [ ] **Step 6: Run full gateway test suite**

Run: `pnpm --filter inference-gateway test`
Expected: PASS, no regressions in existing adapter/router tests.

- [ ] **Step 7: Commit**

```bash
git add apps/inference-gateway/src/images.ts apps/inference-gateway/src/images.test.ts apps/inference-gateway/src/index.ts
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

`downloadMediaAttachment` (`media.ts:103`) takes a full `Attachment` object with a `presignedUrl` already resolved. `editImage`'s input is just a `fileId` from the conversation. Reuse `fetchPresignedUrl` (`apps/agent-orchestrator/src/mastra/tools/mediaCache.ts:5-14`), which already does this exact lookup against `INTERNAL_API_URL` — don't hand-roll a second copy:

```ts
// apps/agent-orchestrator/src/media.ts — add near downloadMediaAttachment
import { fetchPresignedUrl } from './mastra/tools/mediaCache.js'

export async function resolveSourceImage(
  idToken: string,
  fileId: string,
  mimeType: string,
  sessionId: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const presignedUrl = await fetchPresignedUrl(fileId, idToken)
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

(`GET /api/v1/files/:id/presigned-url`, `apps/api/src/routes/files.ts:282`, already scopes to the caller's tenant — no separate tenancy check needed here. Known limitation carried from the spec: `mimeType` comes from the agent's tool-call arguments, not from the file's stored metadata — a wrong guess round-trips into Gemini's `inlineData.mimeType` and surfaces as a generation failure, not a security issue. Fixing this properly needs a files-by-id metadata endpoint that doesn't exist yet; out of scope here.)

**Charge ordering (per spec §6's stated default, resolving the earlier draft's contradiction): call the gateway first, charge only on a non-refused success, refund only if the subsequent upload fails.** This means a refusal is never charged (nothing to refund), and the only refund path is "generated successfully, paid for it, then couldn't save it."

- [ ] **Step 2: Write the failing test for `generateImage`**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const spendCredits = vi.fn()
const resolveRate = vi.fn()
const isUnlimited = vi.fn()
const getPool = vi.fn()
vi.mock('@serverless-saas/credits', () => ({ spendCredits, resolveRate, isUnlimited }))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

import { generateImage } from './generateImage'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.clearAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

describe('generateImage tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -50_000n, kind: 'debit' }))
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3 })
    expect(result).not.toHaveProperty('imageBase64')
  })

  it('does not call the gateway result into a charge and returns a refusal when Gemini refuses — no charge, nothing to refund', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'SAFETY' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'SAFETY' })
  })

  it('refunds with the original grants\' shortest expiry when the post-charge upload fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({
      rows: [{ amount_micro: '-50000', expires_at: '2026-12-01T00:00:00.000Z' }],
    })
    getPool.mockReturnValue({ query })

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 50_000n, kind: 'refund', grantType: 'refund',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('returns insufficientCredits when spendCredits throws after a successful generation', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))

    const result = await generateImage.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
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
import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { getPool } from '../../usage.js'

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

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateImage gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
    }

    // Success — charge now, before the (best-effort) upload.
    const chargeKey = `image:${sessionId}:${randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('image_generation', IMAGE_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED IMAGE GENERATION: no active image_generation rate for model=${IMAGE_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        const amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }

    const buffer = Buffer.from(genResult.imageBase64!, 'base64')
    const extension = (genResult.mimeType ?? 'image/png').split('/')[1] ?? 'png'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Generated Image', content: buffer,
          contentType: genResult.mimeType, extension,
        })
      : null

    if (!attachment) {
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED' }
    }

    return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
  },
})

// Mirrors refundTask's read-back pattern (products/agent-platform/packages/credits/refund.ts:109-169):
// the refund amount and expiry are read back from the ledger, never trusted
// from in-memory state, and the refund grant inherits the SHORTEST expiry
// among the grants the original debit drew from — a refund must never hand
// back a permanent grant for what was an expiring one.
async function refundImageCharge(
  tenantId: string, agentId: string, chargeKey: string,
  rateId: string | null, rateVersion: number | null,
): Promise<void> {
  try {
    const pool = getPool()
    const res = await pool.query<{ amount_micro: string; expires_at: string | null }>(
      `select cl.amount_micro, cg.expires_at
         from credit_ledger cl
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [tenantId, chargeKey],
    )
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n) // negative — what was charged
    if (net >= 0n) return // nothing was actually charged
    const expiresAts = res.rows.map(row => row.expires_at)
    let expiresAt: Date | null = null
    for (const raw of expiresAts) {
      if (raw == null) continue
      const d = new Date(raw)
      if (expiresAt === null || d.getTime() < expiresAt.getTime()) expiresAt = d
    }
    await spendCredits({
      tenantId, amountMicro: -net, key: `${chargeKey}:refund`, kind: 'refund',
      actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
      grantType: 'refund', expiresAt,
    })
  } catch (err) {
    console.error(
      `[credits] UNREFUNDED IMAGE CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} — ` +
      `refund write failed and was swallowed; tenant is still down for a generation that ` +
      `could not be saved. Cause:`, (err as Error).message,
    )
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter agent-orchestrator test generateImage.test.ts`
Expected: PASS

- [ ] **Step 6: Write `editImage.ts` and its test, following the same shape**

Same structure as `generateImage`, with:
- `inputSchema: z.object({ prompt: z.string(), sourceFileId: z.string(), sourceMimeType: z.string() })`
- Before calling the gateway, call `resolveSourceImage(idToken, sourceFileId, sourceMimeType, sessionId)` (Step 1); if it returns `null`, return `{ refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }` — no charge involved, this happens before any generation attempt.
- Cap the resolved source image's byte size in `editImage.ts` itself (spec §4's "cap the source image's byte size... before it's even sent" — it can't literally live in the Zod input schema since that only carries a `fileId`, so enforce it right after `resolveSourceImage` returns): if `Buffer.byteLength(base64, 'base64')` exceeds e.g. 20MB, return `{ refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }` without calling the gateway.
- Gateway call body includes `sourceImageBase64`/`sourceMimeType` alongside `prompt`.
- Same "no active rate" logging as `generateImage` (`console.error('[credits] UNBILLED IMAGE GENERATION: ...')`) — don't drop that branch when copying the structure over.
- Test file `editImage.test.ts` mirrors `generateImage.test.ts`'s four cases, plus one for `SOURCE_IMAGE_UNAVAILABLE` and one for `SOURCE_IMAGE_TOO_LARGE`.

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
- Test: `apps/agent-orchestrator/src/mastra/__tests__/registry.test.ts` (create — note the `__tests__/` subdirectory, matching this codebase's convention, e.g. `mastra/tools/__tests__/readFile.test.ts`)

**Interfaces:**
- Consumes: `generateImage`, `editImage` (Task 4), `tenantContextSchema` (`../context.js`), `selectModel` (`./modelSelection.js`), `getMastraMemory` (`../memory.js`).
- Produces: `directorAgent: Agent`, registered in `AGENT_REGISTRY` with its **tool keys** `generate_image`/`edit_image` (not `generateImage`/`editImage` — see below). `resolveAgent('director')` → `directorAgent`.

**Critical: the Mastra tool key, not `createTool`'s `id`, is what `chatStream.ts` sees.** `chatStream.ts` normalizes the tool name it receives from the model with `.toLowerCase().replace(/_/g, '-')` (see Task 6) — and what it receives is the **property name under `tools: {...}`** in the agent definition, not the `id` field inside `createTool()`. The existing precedent is `renderCanvas.ts` (`id: 'render-canvas'`) registered in `platformAgent.ts` as `render_canvas:` — the key, not the id, is what normalizes to `'render-canvas'`. Registering Director's tools as `tools: { generateImage, editImage }` (camelCase keys) would normalize to `'generateimage'`/`'editimage'`, which Task 6's gate does not match, and generated images would silently never reach the client — reintroducing the exact bug this plan exists to fix. Register as `tools: { generate_image: generateImage, edit_image: editImage }`.

- [ ] **Step 1: Write the failing test**

Real Mastra agents construct a `PostgresStore`/`PgVector`/embedder at import time via `getMastraMemory()` (`memory.ts:96-141`) — importing `registry.ts` unmocked pulls in `platformAgent.ts`, which does this at module load. Every existing test that touches this graph mocks it out first (see `mastra/agent.test.ts:5-12`). Mock the sibling agent modules and `directorAgent` itself so this test only exercises `resolveAgent`/`resolveAgentLabel`'s lookup logic:

```ts
// apps/agent-orchestrator/src/mastra/__tests__/registry.test.ts
import { describe, it, expect, vi } from 'vitest'

const platformAgentStub = { id: 'platform-stub' }
const pmAgentStub = { id: 'pm-stub' }
const architectAgentStub = { id: 'architect-stub' }
const directorAgentStub = { id: 'director-stub' }

vi.mock('../agents/platformAgent.js', () => ({ platformAgent: platformAgentStub }))
vi.mock('../agents/pmAgent.js', () => ({ pmAgent: pmAgentStub }))
vi.mock('../agents/architectAgent.js', () => ({ architectAgent: architectAgentStub }))
vi.mock('../agents/directorAgent.js', () => ({ directorAgent: directorAgentStub }))

import { resolveAgent, resolveAgentLabel } from '../registry.js'

describe('registry — director', () => {
  it('resolves the exact agent name "Director" (lowercased) to directorAgent', () => {
    expect(resolveAgent('Director')).toBe(directorAgentStub)
  })

  it('labels directorAgent correctly', () => {
    expect(resolveAgentLabel(directorAgentStub as never)).toBe('directorAgent')
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
- Call generate_image for a new image from a text description.
- Call edit_image when the user references an existing image in this conversation (by its fileId) and wants it changed.
- If a generation is refused (returns refused: true), tell the user plainly what happened — do not retry automatically, do not describe the refusal as an error.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
- Never invent a fileId — only use one the user or an earlier tool result actually gave you.`
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  // Keys here (not createTool's `id`) are what the model calls and what
  // chatStream.ts's normalizedToolName sees — must stay generate_image/edit_image.
  tools: { generate_image: generateImage, edit_image: editImage },
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
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/registry.ts apps/agent-orchestrator/src/mastra/__tests__/registry.test.ts
git commit -m "feat(orchestrator): add directorAgent and wire into the agent registry"
```

---

### Task 6: `chatStream.ts` attachment delivery

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:129-141, 209`
- Test: `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts` (note the `__tests__/` subdirectory — the real file is not `routes/chatStream.test.ts`; that path doesn't exist)

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

Add to `__tests__/chatStream.test.ts` — note the existing file mocks roughly 10 modules to make `chatStream.ts` importable at all (Postgres, Mastra memory, etc.); add these cases inside that file's existing mock setup rather than a fresh unmocked import:

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

Edit `chatStream.ts:209`. Only add `'generate-image'`/`'edit-image'` — the already-normalized form (`.toLowerCase().replace(/_/g, '-')`, applied before this set is checked) is what actually gets looked up, so a raw-underscore or no-dash variant here is dead weight (the existing `'rendercanvas'`/`'render_canvas'` entries are exactly this — pre-existing dead entries, not a pattern to copy):

```ts
  const SAVE_TOOL_NAMES = new Set([
    'saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks',
    'rendercanvas', 'render-canvas', 'render_canvas',
    'generate-image', 'edit-image',
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
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts
git commit -m "feat(orchestrator): deliver generate-image/edit-image results as chat attachments"
```

---

### Task 7: Seed Director across all four agent/persona rosters

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/personas.ts:10-32`
- Modify: `apps/api/src/routes/onboarding.ts` (after the Architect block, which runs through `onboarding.ts:351` — insert after that line, not mid-block)
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
        // agents.type is a Postgres enum (products/agent-platform/packages/schema/agents.ts:20:
        // 'ops'|'support'|'billing'|'custom'|'product_manager'|'analyst'|'project_manager'|'tech_lead'|'architect').
        // 'assistant' is NOT a member — it only appears in registry.ts's unrelated, unvalidated
        // display list. 'custom' is what backfill-agents.ts already uses for every agent it seeds.
        type: 'custom',
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

Import `personas` from `@serverless-saas/agent-schema/personas` (`products/agent-platform/packages/schema/personas.ts:8` — the package's `./*` export maps to `dist/*`, same package `onboarding.ts` already pulls `agents`/`apiKeys`-adjacent types from). The `personas` seed (Step 1) must have already run against the target database before onboarding creates new tenants, or `directorPersona` resolves to `undefined` and the agent is created with `personaId: null` — log a warning in that branch so a skipped seed step is visible in ops (this is why Task 8 runs the persona seed *before* deploying the Lambda that would otherwise start creating tenants against it).

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

- [ ] **Step 1:** Run the personas seed against dev **first** (`pnpm --filter @serverless-saas/agent-api db:seed:personas`) — must land before the Lambda deploy in Step 2, otherwise every tenant onboarded between the two gets `personaId: null` on its Director row (Task 7, Step 2's fallback).
- [ ] **Step 2:** Rebuild and deploy the Lambda: `sam build --config-file samconfig.dev.toml && sam deploy --config-file samconfig.dev.toml` (picks up the `onboarding.ts` change from Task 7 — rebuild `packages/foundation/*`/product `dist/` first per the known stale-`dist/` footgun).
- [ ] **Step 3:** Restart the orchestrator: `pm2 restart agent-orchestrator` (picks up Tasks 2, 4, 5, 6).
- [ ] **Step 4:** Restart the inference gateway: `pm2 restart inference-gateway` (picks up Task 3).
- [ ] **Step 5:** Run the backfill script against dev (Task 7, Step 3's `backfill-agents.ts`) so existing tenants get Director too, not just new signups.
- [ ] **Step 6:** Publish the Director persona: attach a real preview image via `PUT /ops/personas/:id` (ops portal), then `POST /ops/personas/:id/publish` — required before Director is selectable in the roster (spec §1; the `INCOMPLETE_ASSETS` gate rejects publish without a real `exampleAssetUrl`, `PersonaAvatar`'s generated SVG does not satisfy it).
- [ ] **Step 7:** Manual smoke test: start a chat with Director, ask for an image, confirm it appears as an attachment and the `image_generation` credit charge lands in `credit_ledger`. Ask for an edit referencing the first image's `fileId`. Then send a prompt expected to trigger a safety refusal and confirm no charge lands.
