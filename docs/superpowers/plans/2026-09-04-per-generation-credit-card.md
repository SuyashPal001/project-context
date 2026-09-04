# Per-Generation Credit Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every generated image/video attachment in chat shows a small credit-cost pill that expands to reveal the model used and credits spent.

**Architecture:** `generateImage.ts`/`generateVideo.ts` already compute the exact spend amount and model before charging — thread both through their tool return value. `chatStream.ts`'s existing `attachmentFromCanvasToolResult` (the single place a tool result becomes a persisted message attachment) picks them up into a new optional `generation` field on `AttachmentPayload`. On the web side, `MessageAttachment` gains the matching field, and a new `GeneratedAssetCard` wraps the existing `InlineAttachmentCard` to render the pill + expandable details, without touching `InlineAttachmentCard` itself or its "open on canvas" click behavior.

**Tech Stack:** Mastra tools (Zod schemas), Hono/persistence glue in `apps/agent-orchestrator`, Next.js/React + Radix `Popover`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-04-credit-usage-ui-design.md` (Feature 2: "Per-generation credit card")

## Global Constraints

- Only `model` and `creditsUsedMicro` are captured — **never fabricate** `aspectRatio`/`resolution`/`seed`/`batch`; the gateway doesn't return them today, so the card's field grid only renders fields that are actually present.
- `creditsUsedMicro` is only set on the tool result when the generation was actually charged (unlimited-plan tenants and any tenant that hit the "no active rate" fallback are never charged — see `generateImage.ts`'s `charged` flag — so their generated assets show no credit pill).
- `attachmentFromCanvasToolResult` in `chatStream.ts` stays a pure function (no `Date.now()`/`new Date()` inside it) — a "Created" timestamp is available separately from the message's own `createdAt`, so it is not duplicated into the attachment payload.
- "Open on canvas" behavior (`InlineAttachmentCard`'s existing `handleClick` → `window.__openCanvas()`/`__canvasUpdate`) is untouched — `GeneratedAssetCard` adds an overlay, it does not replace or fork that component.
- Scope is image and video only, matching the reference pattern and the existing `generateImage.ts`/`generateVideo.ts` tools — `generateSong` (audio) is out of scope for this plan.

---

### Task 1: Thread `creditsUsedMicro` and `model` through `generateImage`/`generateVideo`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Produces: both tools' success return value gains two optional fields, `creditsUsedMicro?: string` and `model?: string`, alongside the existing `fileId`/`name`/`fileType`/`size`. `creditsUsedMicro` is present only when `charged` is true.

- [ ] **Step 1: Write the failing test for generateImage**

Add to `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`, inside the `describe('generateImage tool', ...)` block:

```ts
  it('includes creditsUsedMicro and model in the result when the generation was charged', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
  })

  it('omits creditsUsedMicro when the tenant is unlimited (never charged)', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const result = await generateImage.execute!({ prompt: 'a red bicycle' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3, model: 'gemini-3-pro-image-preview' })
    expect(result).not.toHaveProperty('creditsUsedMicro')
  })
```

Also update the existing first test in the file (`'calls the gateway, charges credits only after success, uploads the result, and returns metadata only'`) — its `toEqual` assertion at line 56 will now fail because the result gains two more fields. Change:

```ts
    expect(result).toEqual({ fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3 })
```
to:
```ts
    expect(result).toEqual({
      fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview',
    })
```

- [ ] **Step 2: Write the equivalent failing tests for generateVideo**

Add the same two tests (adjusted for video) to `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts` — read the file first to match its exact mock setup (it mirrors `generateImage.test.ts` with `videoBase64`/`VIDEO_MODEL` in place of `imageBase64`/`IMAGE_MODEL`), then add:

```ts
  it('includes creditsUsedMicro and model in the result when the generation was charged', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!({ prompt: 'a car driving' } as never, baseCtx())

    expect(result).toEqual({
      fileId: 'f1', name: 'x.mp4', fileType: 'video/mp4', size: 3,
      creditsUsedMicro: '50000', model: 'gemini-omni-1.1-flash',
    })
  })

  it('omits creditsUsedMicro when the tenant is unlimited (never charged)', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!({ prompt: 'a car driving' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ fileId: 'f1', name: 'x.mp4', fileType: 'video/mp4', size: 3, model: 'gemini-omni-1.1-flash' })
    expect(result).not.toHaveProperty('creditsUsedMicro')
  })
```

Also find and update generateVideo.test.ts's equivalent of the "returns metadata only" test (its first/primary success test) the same way Step 1 updated generateImage's — add `creditsUsedMicro: '50000', model: 'gemini-omni-1.1-flash'` to its expected result.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter agent-orchestrator test generateImage.test generateVideo.test`
Expected: FAIL — `result` doesn't have `creditsUsedMicro`/`model` yet; the two updated pre-existing tests fail on the now-stricter `toEqual`.

- [ ] **Step 4: Implement in generateImage.ts**

In `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`, extend `outputSchema`:

```ts
const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  model: z.string().optional(),
})
```

And change the final return statement from:

```ts
    return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
```
to:
```ts
    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: IMAGE_MODEL,
    }
```

Note: `amountMicro` is declared inside the `if (!(await isUnlimited(tenantId)))` block's `else` branch, scoped to that block — it needs to be hoisted so the final `return` can see it. Change the declaration from `const amountMicro = costMicro(...)` (inside the block) to declaring `let amountMicro = 0n` alongside the existing `let charged = false` / `let rateId: string | null = null` / `let rateVersion: number | null = null` block near the top of the charge section, then assign it (`amountMicro = costMicro(rate.schema, { count: 1 })`) instead of declaring it inline.

- [ ] **Step 5: Implement the equivalent change in generateVideo.ts**

Same three edits (outputSchema, hoist `amountMicro`, final return) in `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`, using `VIDEO_MODEL` in place of `IMAGE_MODEL`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter agent-orchestrator test generateImage.test generateVideo.test`
Expected: PASS (all tests in both files)

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "feat(orchestrator): report creditsUsedMicro and model from image/video generation"
```

---

### Task 2: Carry `generation` metadata into the persisted attachment

**Files:**
- Modify: `apps/agent-orchestrator/src/persistence.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`
- Test: `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts`

**Interfaces:**
- Consumes: `result.creditsUsedMicro` / `result.model` (Task 1's new tool-result fields).
- Produces: `AttachmentPayload` gains `generation?: { creditsUsedMicro: string; model: string }`, exported from `apps/agent-orchestrator/src/persistence.ts`. `attachmentFromCanvasToolResult('generate-image' | 'generate-video', result)` populates it when both fields are present in `result`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts`, inside `describe('attachmentFromCanvasToolResult — generate-image/edit-image', ...)`:

```ts
  it('carries creditsUsedMicro and model into a generation field when present', () => {
    const result = { fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 100, creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' }
    expect(attachmentFromCanvasToolResult('generate-image', result)).toEqual({
      fileId: 'f1', name: 'x.png', type: 'image/png', size: 100,
      generation: { creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' },
    })
  })

  it('omits generation when the tool result has no creditsUsedMicro (unlimited-plan tenant)', () => {
    const result = { fileId: 'f1', name: 'x.png', fileType: 'image/png', size: 100, model: 'gemini-3-pro-image-preview' }
    const attachment = attachmentFromCanvasToolResult('generate-image', result)
    expect(attachment).not.toHaveProperty('generation')
  })
```

And inside `describe('attachmentFromCanvasToolResult — generate-video', ...)`:

```ts
  it('carries creditsUsedMicro and model into a generation field when present', () => {
    const result = { fileId: 'f1', name: 'clip.mp4', fileType: 'video/mp4', size: 100, creditsUsedMicro: '50000', model: 'gemini-omni-1.1-flash' }
    expect(attachmentFromCanvasToolResult('generate-video', result)).toEqual({
      fileId: 'f1', name: 'clip.mp4', type: 'video/mp4', size: 100,
      generation: { creditsUsedMicro: '50000', model: 'gemini-omni-1.1-flash' },
    })
  })
```

And inside `describe('attachmentFromCanvasToolResult', ...)` (the render-canvas one), confirm render-canvas results (which never carry `creditsUsedMicro`/`model`) are unaffected — this is already covered by the existing tests in that block since they'll keep passing with no `generation` key, but add one explicit regression case:

```ts
  it('never adds a generation field for render-canvas results', () => {
    const attachment = attachmentFromCanvasToolResult('render-canvas', { fileId: 'file-1', name: 'doc.md', fileType: 'text/markdown', size: 10 })
    expect(attachment).not.toHaveProperty('generation')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter agent-orchestrator test chatStream.test -- -t "generation"`
Expected: FAIL — `attachmentFromCanvasToolResult` doesn't produce a `generation` field yet.

- [ ] **Step 3: Extend `AttachmentPayload` in persistence.ts**

In `apps/agent-orchestrator/src/persistence.ts`, change:

```ts
export interface AttachmentPayload {
  fileId: string
  name: string
  type: string
  size: number
}
```
to:
```ts
export interface AttachmentPayload {
  fileId: string
  name: string
  type: string
  size: number
  generation?: { creditsUsedMicro: string; model: string }
}
```

- [ ] **Step 4: Implement in chatStream.ts**

In `apps/agent-orchestrator/src/routes/chatStream.ts`, change `attachmentFromCanvasToolResult`:

```ts
export function attachmentFromCanvasToolResult(
  normalizedToolName: string,
  result: Record<string, unknown>,
): AttachmentPayload | null {
  if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'].includes(normalizedToolName)) return null
  if (typeof result.fileId !== 'string') return null
  const attachment: AttachmentPayload = {
    fileId: result.fileId,
    name: String(result.name ?? 'document.md'),
    type: String(result.fileType ?? 'text/markdown'),
    size: typeof result.size === 'number' ? result.size : 0,
  }
  if (typeof result.creditsUsedMicro === 'string' && typeof result.model === 'string') {
    attachment.generation = { creditsUsedMicro: result.creditsUsedMicro, model: result.model }
  }
  return attachment
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter agent-orchestrator test chatStream.test`
Expected: PASS (all tests in the file)

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts
git commit -m "feat(orchestrator): carry generation credit/model metadata into persisted attachments"
```

---

### Task 3: `GeneratedAssetCard` component

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts`
- Create: `apps/web/components/platform/chat/GeneratedAssetCard.tsx`
- Modify: `apps/web/components/platform/chat/MessageItem.tsx`
- Create: `apps/web/components/platform/chat/GeneratedAssetCard.test.tsx`

**Interfaces:**
- Consumes: `InlineAttachmentCard` (unmodified, from `./InlineAttachmentCard`), `MessageAttachment` (extended below), `Popover`/`PopoverTrigger`/`PopoverContent` from `@/components/ui/popover`, `microToCredits` from `@/lib/hooks/useCredits`.
- Produces: `GeneratedAssetCard` component with props `{ file: MessageAttachment; url: string | null; createdAt: string }`, exported from `apps/web/components/platform/chat/GeneratedAssetCard.tsx`.

- [ ] **Step 1: Extend `MessageAttachment`**

In `apps/web/components/platform/chat/types.ts`, change:

```ts
export interface MessageAttachment {
    id: string;        // local UI id (uuid)
    fileId?: string;   // S3 fileId — used to re-fetch presigned URL on reload
    name: string;
    type: string;
    size?: number;
    previewUrl?: string;
}
```
to:
```ts
export interface MessageAttachment {
    id: string;        // local UI id (uuid)
    fileId?: string;   // S3 fileId — used to re-fetch presigned URL on reload
    name: string;
    type: string;
    size?: number;
    previewUrl?: string;
    generation?: { creditsUsedMicro: string; model: string };
}
```

- [ ] **Step 2: Write the failing component test**

Create `apps/web/components/platform/chat/GeneratedAssetCard.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneratedAssetCard } from './GeneratedAssetCard';
import type { MessageAttachment } from './types';

afterEach(() => cleanup());

const baseFile: MessageAttachment = {
    id: 'att-1', fileId: 'f1', name: 'sunset.png', type: 'image/png', size: 12345,
};

describe('GeneratedAssetCard', () => {
    it('renders the plain attachment card with no credit pill when generation is absent', () => {
        render(<GeneratedAssetCard file={baseFile} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);
        expect(screen.queryByTestId('generation-credit-pill')).toBeNull();
    });

    it('shows a credit pill when generation metadata is present', () => {
        const file: MessageAttachment = {
            ...baseFile,
            generation: { creditsUsedMicro: '310000', model: 'gpt-image-2' },
        };
        render(<GeneratedAssetCard file={file} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);
        const pill = screen.getByTestId('generation-credit-pill');
        expect(pill.textContent).toContain('0.31');
    });

    it('expands to show model and credits used, and omits fields that are not known', async () => {
        const file: MessageAttachment = {
            ...baseFile,
            generation: { creditsUsedMicro: '310000', model: 'gpt-image-2' },
        };
        render(<GeneratedAssetCard file={file} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);

        await userEvent.click(screen.getByTestId('generation-credit-pill'));

        const details = await screen.findByTestId('generation-details');
        expect(details.textContent).toContain('gpt-image-2');
        expect(details.textContent).toContain('0.31');
        expect(details.textContent).not.toContain('Aspect ratio');
        expect(details.textContent).not.toContain('Resolution');
        expect(details.textContent).not.toContain('Seed');
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test GeneratedAssetCard.test`
Expected: FAIL — `GeneratedAssetCard` module does not exist yet.

- [ ] **Step 4: Create `GeneratedAssetCard.tsx`**

```tsx
'use client';

import { InlineAttachmentCard } from './InlineAttachmentCard';
import type { MessageAttachment } from './types';
import { microToCredits } from '@/lib/hooks/useCredits';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface GeneratedAssetCardProps {
  file: MessageAttachment;
  url: string | null;
  createdAt: string;
}

// Wraps InlineAttachmentCard (unmodified — same click-to-open-on-canvas
// behavior) with a credit-cost pill overlay, shown only when the file
// carries generation metadata (i.e. it came from generate_image/generate_video,
// not a user upload). The pill's own click is stopped from bubbling so it
// doesn't also trigger the card's open-on-canvas handler underneath it.
export function GeneratedAssetCard({ file, url, createdAt }: GeneratedAssetCardProps) {
  if (!file.generation) {
    return <InlineAttachmentCard file={file} url={url} />;
  }

  const { creditsUsedMicro, model } = file.generation;
  const credits = microToCredits(creditsUsedMicro);

  return (
    <div className="relative inline-block">
      <InlineAttachmentCard file={file} url={url} />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="generation-credit-pill"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-1.5 right-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60 hover:bg-background transition-colors"
          >
            {credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-56 p-3 text-xs space-y-1.5"
          data-testid="generation-details"
        >
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Model</span>
            <span className="font-mono">{model}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Created</span>
            <span>{new Date(createdAt).toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between pt-1.5 border-t border-border/60 font-medium">
            <span>Credits used</span>
            <span className="font-mono">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test GeneratedAssetCard.test`
Expected: PASS (all 3 tests)

- [ ] **Step 6: Wire `GeneratedAssetCard` into `MessageItem.tsx`**

In `apps/web/components/platform/chat/MessageItem.tsx`, change the import:

```tsx
import { InlineAttachmentCard } from "./InlineAttachmentCard";
```
to:
```tsx
import { GeneratedAssetCard } from "./GeneratedAssetCard";
```

And change the attachments render block:

```tsx
                {message.attachments && message.attachments.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-2 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {message.attachments.map((file, index) => {
                            const url = (file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null;
                            return <InlineAttachmentCard key={file.id ?? `att-${index}`} file={file} url={url} />;
                        })}
                    </div>
                )}
```
to:
```tsx
                {message.attachments && message.attachments.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-2 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {message.attachments.map((file, index) => {
                            const url = (file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null;
                            return <GeneratedAssetCard key={file.id ?? `att-${index}`} file={file} url={url} createdAt={message.createdAt} />;
                        })}
                    </div>
                )}
```

`message.createdAt` is already a field on the message object per `apps/web/components/platform/chat/types.ts:136` — no other change needed to obtain it.

- [ ] **Step 7: Run the full web test suite to check for regressions**

Run: `pnpm --filter web test`
Expected: PASS — confirm no other test imports `InlineAttachmentCard` directly through `MessageItem` in a way that assumed the old import (a direct `InlineAttachmentCard.test.tsx` would be unaffected since that component itself is unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/components/platform/chat/GeneratedAssetCard.tsx apps/web/components/platform/chat/GeneratedAssetCard.test.tsx apps/web/components/platform/chat/MessageItem.tsx
git commit -m "feat(web): show a credit-cost pill and details popover on generated image/video attachments"
```

---

## Self-Review Notes

- **Spec coverage:** capture at spend time in the tools (Task 1), threading through the one real bridge point `attachmentFromCanvasToolResult` (Task 2), and the UI card that only renders known fields (Task 3) — all of Feature 2's spec sections are covered. The explicit non-goals (aspect ratio/resolution/seed/batch, "Open on canvas" changes, song/audio) have no tasks, matching the spec.
- **Type consistency:** `creditsUsedMicro`/`model` (Task 1's tool output) → `AttachmentPayload.generation` (Task 2) → `MessageAttachment.generation` (Task 3) all use the same two field names and string type throughout.
- **No placeholders:** every step has real, complete code. Task 1 explicitly calls out the `amountMicro` scoping change needed (not just "wire it up") since that's an easy detail to miss when hoisting a `const` out of an `else` block.
- **Regression risk called out explicitly:** Task 1 Step 1 and Task 2 Step 1 both flag the pre-existing tests whose `toEqual` assertions must be updated, not just the new tests to add — a plan that only adds tests without flagging existing ones that will break is a common miss.
