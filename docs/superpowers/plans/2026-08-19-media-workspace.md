# Media Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Higgsfield-style media workspace to the chat panel — a right-pane tab strip, a "Chat History" asset gallery, a type-aware lightbox (video/audio/markdown), and an "Add to task" action that pre-populates the compose box.

**Architecture:** Extend the existing `Canvas` right pane rather than build a second pane. Replace its closed `activeTab: 'artifact' | 'knowledge'` union with a generic `tabs: CanvasTab[]` model covering artifact, knowledge (pinned), file, and gallery tabs. A new backend endpoint derives an `Asset[]` list from each conversation's existing `attachments`/`artifactRef` message columns (no new table). A new `AssetGallery` + `AssetLightbox` pair renders that list; the lightbox center panel switches by asset type.

**Tech Stack:** Next.js App Router, Hono (agent-platform API), Drizzle ORM, `react-markdown` + `remark-gfm` (already a dependency), shadcn `Dialog` primitive, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-media-workspace-design.md`

## Global Constraints

- No DB migration — the assets endpoint derives `Asset[]` by reading the existing `attachments`/`artifactRef` jsonb columns on `messages`.
- The `knowledge` Canvas tab stays pinned: always present, `closeable: false`. Every other tab (`artifact`, `file`, `gallery`) is closeable.
- Asset scope is unified: PRD/roadmap/task artifacts and generated media (video/audio/image/file/markdown) both appear as gallery cards and both open through the same tab/lightbox machinery.
- The gallery's asset list is sourced from the new backend endpoint, not derived client-side from already-loaded messages.
- Reuse the existing `Dialog` primitive (`apps/web/components/ui/dialog.tsx`) as the lightbox's overlay scaffolding — do not build a new portal.
- Reuse `react-markdown` + `remark-gfm` (already installed, already used in `StreamingMessage.tsx`) for markdown rendering — do not hand-roll a parser.
- Follow the existing `window.__canvasUpdate` / `window.__openCanvas` bridge pattern for cross-pane calls (message thread → Canvas, compose box → gallery) rather than lifting state into `page.tsx` — this matches how the codebase already solves this problem.

---

## Task 1: Shared `Asset` type

**Files:**
- Create: `apps/web/types/assets.ts`

**Interfaces:**
- Produces: `AssetType`, `Asset` — consumed by every later frontend task.

- [ ] **Step 1: Write the type file**

```ts
// apps/web/types/assets.ts

export type AssetType = 'video' | 'audio' | 'image' | 'markdown' | 'file' | 'prd' | 'roadmap' | 'tasks';

export interface Asset {
  id: string;
  type: AssetType;
  filename: string;
  /** Original MIME type — present for video/audio/image/file/markdown assets, absent for prd/roadmap/tasks. */
  mimeType?: string;
  thumbnailUrl?: string;
  size?: number;
  createdAt: string;
  sourceMessageId: string;
  /** Present for uploaded/generated files — resolves a download URL via GET /api/v1/files/:fileId/presigned-url */
  fileId?: string;
  /** Present for prd/roadmap/tasks — feeds GET /api/v1/prds/:id or /api/v1/plans/:id */
  entityId?: string;
}

export interface AssetsResponse {
  data: Asset[];
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/types/assets.ts
git commit -m "feat(media-workspace): add shared Asset type"
```

---

## Task 2: Backend `GET /conversations/:id/assets` endpoint

**Files:**
- Create: `products/agent-platform/packages/api/routes/assets.ts`
- Test: `products/agent-platform/packages/api/__tests__/assets.test.ts`
- Modify: `products/agent-platform/packages/api/index.ts:15` (import), `:72` (mount)

**Interfaces:**
- Produces: `assetsRoutes` (Hono router), mounted at `/conversations` so the full path is `GET /conversations/:conversationId/assets` (frontend calls it as `/api/v1/conversations/:conversationId/assets`, matching the existing `/api/v1/conversations/:id/messages` convention).
- Response shape: `{ data: AssetDTO[] }` where `AssetDTO` structurally matches `Asset` from Task 1 (this is a backend/frontend DTO boundary — the shapes are kept in sync by hand, not shared via import, since the backend package must not depend on `apps/web`).

- [ ] **Step 1: Write the failing test**

```ts
// products/agent-platform/packages/api/__tests__/assets.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: () => true }));

// Hono context vars (`c.get('requestContext')`, `c.get('userId')`) are not
// settable via the third argument to `.request()` — the codebase's
// established pattern (see __tests__/conversations.persona.test.ts) wraps
// the router under test in an app that sets them via middleware first.
function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: ['conversations:read'] });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

describe('GET /conversations/:id/assets', () => {
    beforeEach(() => vi.clearAllMocks());

    it('maps attachments and artifactRef from messages into a flat asset list', async () => {
        const conversationRow = { id: 'conv-1', tenantId: 'tenant-1', userId: 'user-1' };
        const messageRows = [
            {
                id: 'msg-1',
                createdAt: new Date('2026-08-01T00:00:00Z'),
                attachments: [{ fileId: 'file-1', name: 'clip.mp4', type: 'video/mp4', size: 1024 }],
                artifactRef: null,
            },
            {
                id: 'msg-2',
                createdAt: new Date('2026-08-02T00:00:00Z'),
                attachments: null,
                artifactRef: { type: 'prd', entityId: 'prd-1', title: 'Onboarding PRD' },
            },
            {
                id: 'msg-3',
                createdAt: new Date('2026-08-03T00:00:00Z'),
                attachments: null,
                artifactRef: null,
            },
        ];

        let call = 0;
        dbMock.select.mockImplementation(() => ({
            from: () => ({
                where: (...args: unknown[]) => {
                    call += 1;
                    // First select() is resolveConversation's lookup, second is the messages list.
                    if (call === 1) {
                        return { limit: async () => [conversationRow] };
                    }
                    return { orderBy: async () => messageRows };
                },
            }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-1/assets');
        const body = await res.json() as { data: Array<{ id: string; type: string; filename: string }> };

        expect(res.status).toBe(200);
        expect(body.data).toEqual([
            expect.objectContaining({ id: 'file-1', type: 'video', filename: 'clip.mp4', sourceMessageId: 'msg-1' }),
            expect.objectContaining({ id: 'prd-1', type: 'prd', filename: 'Onboarding PRD', sourceMessageId: 'msg-2' }),
        ]);
    });

    it('returns 404 when the conversation does not belong to this tenant/user', async () => {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-missing/assets');

        expect(res.status).toBe(404);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd products/agent-platform/packages/api && npx vitest run __tests__/assets.test.ts`
Expected: FAIL — `Cannot find module '../routes/assets'`

- [ ] **Step 3: Write the route**

```ts
// products/agent-platform/packages/api/routes/assets.ts
import { Hono } from 'hono';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '../db';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const assetsRoutes = new Hono<AppEnv>();

type AssetType = 'video' | 'audio' | 'image' | 'markdown' | 'file' | 'prd' | 'roadmap' | 'tasks';

interface AssetDTO {
    id: string;
    type: AssetType;
    filename: string;
    mimeType?: string;
    size?: number;
    createdAt: string;
    sourceMessageId: string;
    fileId?: string;
    entityId?: string;
}

function classifyMimeType(mimeType: string, filename: string): AssetType {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'text/markdown' || filename.toLowerCase().endsWith('.md')) return 'markdown';
    return 'file';
}

function messageToAssets(message: typeof messages.$inferSelect): AssetDTO[] {
    const assets: AssetDTO[] = [];
    const createdAt = message.createdAt.toISOString();

    const attachments = message.attachments as Array<{ fileId?: string; name: string; type: string; size?: number }> | null;
    if (attachments) {
        for (const att of attachments) {
            if (!att.fileId) continue; // no downloadable reference — nothing for the gallery to open
            assets.push({
                id: att.fileId,
                type: classifyMimeType(att.type, att.name),
                filename: att.name,
                mimeType: att.type,
                size: att.size,
                createdAt,
                sourceMessageId: message.id,
                fileId: att.fileId,
            });
        }
    }

    const artifactRef = message.artifactRef as { type: 'prd' | 'roadmap' | 'tasks'; entityId: string; title: string } | null;
    if (artifactRef) {
        assets.push({
            id: artifactRef.entityId,
            type: artifactRef.type,
            filename: artifactRef.title,
            createdAt,
            sourceMessageId: message.id,
            entityId: artifactRef.entityId,
        });
    }

    return assets;
}

async function resolveConversation(conversationId: string, tenantId: string, userId: string) {
    const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(
            eq(conversations.id, conversationId),
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, userId),
        ))
        .limit(1);
    return conversation ?? null;
}

// GET /conversations/:conversationId/assets — everything generated/attached in this conversation
assetsRoutes.get('/:conversationId/assets', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    if (!await resolveConversation(conversationId, tenantId, userId)) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const rows = await db
        .select()
        .from(messages)
        .where(and(
            eq(messages.conversationId, conversationId),
            eq(messages.tenantId, tenantId),
        ))
        .orderBy(asc(messages.createdAt));

    const data = rows.flatMap(messageToAssets);

    return c.json({ data });
});
```

- [ ] **Step 4: Mount the route**

```ts
// products/agent-platform/packages/api/index.ts
// add near the other route imports (line 15):
import { assetsRoutes } from './routes/assets';

// add next to the messagesRoutes mount (line 72):
api.route('/conversations', assetsRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd products/agent-platform/packages/api && npx vitest run __tests__/assets.test.ts`
Expected: PASS (both tests)

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/routes/assets.ts \
        products/agent-platform/packages/api/__tests__/assets.test.ts \
        products/agent-platform/packages/api/index.ts
git commit -m "feat(media-workspace): add GET /conversations/:id/assets endpoint"
```

---

## Task 3: `useConversationAssets` fetch hook

**Files:**
- Create: `apps/web/hooks/useConversationAssets.ts`
- Test: `apps/web/hooks/useConversationAssets.test.ts`

**Interfaces:**
- Consumes: `Asset`, `AssetsResponse` from Task 1 (`apps/web/types/assets.ts`); `api.get` from `apps/web/lib/api.ts`.
- Produces: `useConversationAssets(conversationId: string | undefined)` → `{ assets: Asset[], isLoading: boolean, refetch: () => void }`, built on `@tanstack/react-query`'s `useQuery` (already the query client used throughout `apps/web`, e.g. `useChatStream.ts:162`). Consumed by Task 6 (`AssetGallery`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/hooks/useConversationAssets.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    api: { get: vi.fn(async () => ({ data: [{ id: 'a1', type: 'video', filename: 'clip.mp4', createdAt: '2026-08-01T00:00:00Z', sourceMessageId: 'm1' }] })) },
}));

describe('useConversationAssets query key', () => {
    it('builds the assets endpoint path from the conversation id', async () => {
        const { api } = await import('@/lib/api');
        const { assetsQueryOptions } = await import('./useConversationAssets');

        const options = assetsQueryOptions('conv-1');
        await options.queryFn();

        expect(api.get).toHaveBeenCalledWith('/api/v1/conversations/conv-1/assets');
        expect(options.queryKey).toEqual(['conversation-assets', 'conv-1']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run hooks/useConversationAssets.test.ts`
Expected: FAIL — `Cannot find module './useConversationAssets'`

- [ ] **Step 3: Write the hook**

```ts
// apps/web/hooks/useConversationAssets.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Asset, AssetsResponse } from '@/types/assets';

export function assetsQueryOptions(conversationId: string) {
    return {
        queryKey: ['conversation-assets', conversationId] as const,
        queryFn: () => api.get<AssetsResponse>(`/api/v1/conversations/${conversationId}/assets`),
    };
}

export function useConversationAssets(conversationId: string | undefined) {
    const query = useQuery({
        ...(conversationId ? assetsQueryOptions(conversationId) : { queryKey: ['conversation-assets', 'none'] as const, queryFn: async () => ({ data: [] as Asset[] }) }),
        enabled: !!conversationId,
    });

    return {
        assets: query.data?.data ?? [],
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run hooks/useConversationAssets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/hooks/useConversationAssets.ts apps/web/hooks/useConversationAssets.test.ts
git commit -m "feat(media-workspace): add useConversationAssets fetch hook"
```

---

## Task 4: `CanvasTab` model

**Files:**
- Modify: `apps/web/components/platform/canvas/types.ts`
- Modify: `apps/web/hooks/useCanvas.ts`

**Interfaces:**
- Produces: `CanvasTabKind`, `CanvasTab` (in `types.ts`); `useCanvas()` gains no new return fields yet (tab state lives inside `Canvas.tsx` per Task 5 — `useCanvas` only owns open/close/expand of the *pane*, which is unaffected by the tab-model change). This task only lands the type; Task 5 consumes it.
- Consumed by: Task 5 (`Canvas.tsx`), Task 6 (`AssetGallery`), Task 10 (`CanvasTabStrip`).

- [ ] **Step 1: Add the tab types**

```ts
// apps/web/components/platform/canvas/types.ts
// Add after the existing ArtifactState/CanvasAction/CanvasEventData exports:

export type CanvasTabKind = 'artifact' | 'knowledge' | 'file' | 'gallery';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  title: string;
  closeable: boolean;
  /** Present only for kind: 'artifact' */
  artifact?: ArtifactState;
  /** Present only for kind: 'file' */
  asset?: import('@/types/assets').Asset;
}
```

Also extend `CanvasAction` and `CanvasEventData` for the new asset-open bridge call:

```ts
// types.ts — extend the existing CanvasAction union:
export type CanvasAction =
  | 'screenshot'
  | 'click'
  | 'type'
  | 'navigate'
  | 'scroll'
  | 'file_created'
  | 'artifact_start'
  | 'artifact_chunk'
  | 'artifact_done'
  | 'artifact_load'
  | 'asset_open';

// types.ts — extend the existing CanvasEventData interface:
export interface CanvasEventData {
  // ...existing fields unchanged...
  asset?: import('@/types/assets').Asset;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/platform/canvas/types.ts
git commit -m "feat(media-workspace): add CanvasTab model and asset_open bridge action"
```

---

## Task 5: `Canvas.tsx` tabs\[] refactor

**Files:**
- Modify: `apps/web/components/platform/canvas/Canvas.tsx`

**Interfaces:**
- Consumes: `CanvasTab`, `CanvasTabKind` (Task 4); `Asset` (Task 1).
- Produces: internal `tabs: CanvasTab[]` / `activeTabId: string` state, replacing `activeTab`/`artifact`. Exposes no new props — `CanvasProps` is unchanged so `page.tsx` needs no edit in this task. `window.__canvasUpdate` keeps its existing signature but now also handles `action: 'asset_open'`.
- This task deliberately changes one visible behavior: on fresh mount with no artifact ever created, only the `knowledge` tab shows (no more permanent empty-state "Artifact" tab). This is the intended effect of unifying `artifact` into the same dynamic-tab model as `file`/`gallery` tabs, per the approved design.

- [ ] **Step 1: Replace state and add tab helpers**

In `Canvas.tsx`, replace:

```ts
const [artifact, setArtifact] = useState<ArtifactState | null>(null);
const [activeTab, setActiveTab] = useState<'artifact' | 'knowledge'>('artifact');
```

with:

```ts
const KNOWLEDGE_TAB: CanvasTab = { id: 'knowledge', kind: 'knowledge', title: 'Knowledge Base', closeable: false };
const ARTIFACT_TAB_ID = 'artifact';

const [tabs, setTabs] = useState<CanvasTab[]>([KNOWLEDGE_TAB]);
const [activeTabId, setActiveTabId] = useState<string>('knowledge');

const upsertArtifactTab = useCallback((updater: (prev: ArtifactState | null) => ArtifactState | null, focus: boolean) => {
  setTabs(prev => {
    const existing = prev.find(t => t.id === ARTIFACT_TAB_ID);
    const nextArtifact = updater(existing?.artifact ?? null);
    if (!nextArtifact) return prev;
    if (existing) {
      return prev.map(t => t.id === ARTIFACT_TAB_ID ? { ...t, title: nextArtifact.title, artifact: nextArtifact } : t);
    }
    return [...prev, { id: ARTIFACT_TAB_ID, kind: 'artifact', title: nextArtifact.title, closeable: true, artifact: nextArtifact }];
  });
  if (focus) setActiveTabId(ARTIFACT_TAB_ID);
}, []);

const openAssetTab = useCallback((asset: Asset) => {
  const tabId = `file-${asset.id}`;
  setTabs(prev => prev.some(t => t.id === tabId)
    ? prev
    : [...prev, { id: tabId, kind: 'file', title: asset.filename, closeable: true, asset }]);
  setActiveTabId(tabId);
}, []);

const openGalleryTab = useCallback(() => {
  const tabId = 'gallery';
  setTabs(prev => prev.some(t => t.id === tabId)
    ? prev
    : [...prev, { id: tabId, kind: 'gallery', title: 'Chat History', closeable: true }]);
  setActiveTabId(tabId);
}, []);

const closeTab = useCallback((tabId: string) => {
  setTabs(prev => {
    const next = prev.filter(t => t.id !== tabId);
    setActiveTabId(current => {
      if (current !== tabId) return current;
      return next[next.length - 1]?.id ?? 'knowledge';
    });
    return next;
  });
}, []);

const activeTab = tabs.find(t => t.id === activeTabId) ?? KNOWLEDGE_TAB;
```

Add the import at the top of the file:

```ts
import type { CanvasTab } from './types';
import type { Asset } from '@/types/assets';
```

- [ ] **Step 2: Rewire the PRD-restore effect**

Replace the `agentId` restore effect's body (previously called `setArtifact(...)` + `setActiveTab('artifact')`) with:

```ts
useEffect(() => {
  if (!agentId) return;
  api.get<{ data: Array<{ id: string; title: string; content: string; status: string; version: number }> }>(
    `/api/v1/prds?agentId=${agentId}`
  ).then(res => {
    const prd = res.data?.[0];
    if (!prd) return;
    // Only steal focus if the tab list is still at its initial state — a user who has
    // already opened other tabs should not be yanked back to the restored artifact.
    const isInitial = activeTabId === 'knowledge' && tabs.length === 1;
    upsertArtifactTab(() => ({
      type: 'prd',
      title: prd.title,
      content: prd.content,
      isStreaming: false,
      entityId: prd.id,
      entityMeta: { version: prd.version },
      approveStatus: prd.status === 'approved' ? 'done' : 'idle',
    }), isInitial);
  }).catch(() => {});
}, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 3: Rewire `handleCanvasUpdate`**

Replace the `artifact_start` / `artifact_chunk` / `artifact_done` / `artifact_load` branches:

```ts
if (action === 'artifact_start') {
  upsertArtifactTab(() => ({
    type: data.artifactType!,
    title: data.artifactTitle!,
    content: '',
    isStreaming: true,
    entityId: null,
    entityMeta: null,
    approveStatus: 'idle',
  }), true);
  onActivity?.();
  return;
}

if (action === 'artifact_chunk') {
  upsertArtifactTab(prev => prev ? { ...prev, content: prev.content + (data.chunk ?? '') } : prev, false);
  onActivity?.();
  return;
}

if (action === 'artifact_done') {
  const meta = data.entityMeta ?? null;
  upsertArtifactTab(prev => prev ? {
    ...prev,
    isStreaming: false,
    entityId: data.entityId ?? prev.entityId,
    entityMeta: meta,
    pmRunId: (meta as any)?.pmRunId ?? prev.pmRunId,
    pmStepId: (meta as any)?.pmStepId ?? prev.pmStepId,
  } : prev, false);
  onActivity?.();
  return;
}

if (action === 'artifact_load') {
  const { artifactType, artifactTitle, entityId, chunk: content, entityMeta } = data;
  const type = artifactType!;
  const title = String(artifactTitle ?? type?.toUpperCase() ?? '');
  const pmRunId = (entityMeta as any)?.pmRunId as string | undefined;
  const pmStepId = (entityMeta as any)?.pmStepId as string | undefined;
  const base = { type, title, isStreaming: false, entityId: entityId ?? null, entityMeta: entityMeta ?? null, approveStatus: 'idle' as const, pmRunId, pmStepId };
  if (content) {
    upsertArtifactTab(() => ({ ...base, content: String(content) }), true);
  } else if (type === 'prd' && entityId) {
    api.get<{ data: { content: string } }>(`/api/v1/prds/${entityId}`)
      .then(res => { const c = res.data?.content; if (c) upsertArtifactTab(() => ({ ...base, content: c }), true); })
      .catch(() => {});
  } else {
    upsertArtifactTab(() => ({ ...base, content: '' }), true);
  }
  onActivity?.();
  return;
}

if (action === 'asset_open') {
  if (data.asset) openAssetTab(data.asset);
  onActivity?.();
  return;
}
```

- [ ] **Step 4: Rewire `handleApprove`'s next-artifact transition and `handleReset`**

In `handleApprove`, replace:

```ts
setArtifact({ ...nextArtifactObject });
setActiveTab('artifact');
(window as any).__openCanvas?.();
```

with:

```ts
upsertArtifactTab(() => ({
  type: nextType as ArtifactType,
  title: nextTitle,
  content: '',
  isStreaming: false,
  entityId: nextEntityId,
  entityMeta: data.taskCount != null ? { taskCount: data.taskCount } : null,
  approveStatus: 'idle',
  pmRunId: data.runId,
  pmStepId: data.stepId,
}), true);
(window as any).__openCanvas?.();
```

Replace `handleReset`:

```ts
const handleReset = useCallback(() => {
  setState(initialState);
  setRecentFiles([]);
  setTabs([KNOWLEDGE_TAB]);
  setActiveTabId('knowledge');
}, []);
```

- [ ] **Step 5: Rewire the render**

Replace the tab-bar JSX (the two hardcoded `<button>`s) and the tab-content JSX (the `activeTab === 'artifact' ? ... : <KnowledgeBaseSection />` block) with a switch over `activeTab.kind`, still inline for now — the dedicated `CanvasTabStrip` component lands in Task 10:

```tsx
{/* Tab bar — always visible */}
<div className="flex-none flex border-b border-border overflow-x-auto">
  {tabs.map(tab => (
    <button
      key={tab.id}
      className={`flex-none px-4 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap ${
        tab.id === activeTabId
          ? 'text-foreground border-b-2 border-primary'
          : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={() => setActiveTabId(tab.id)}
    >
      {tab.title}
      {tab.kind === 'artifact' && tab.artifact?.isStreaming && (
        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </button>
  ))}
</div>

{/* Scrollable body */}
<div className="flex-1 overflow-y-auto flex flex-col">
  {/* Recent Files */}
  {recentFiles.length > 0 && activeTab.kind === 'knowledge' && (
    <div className="flex-none px-4 pb-3 space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px flex-1 bg-border/50" />
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Created Files</span>
        <div className="h-px flex-1 bg-border/50" />
      </div>
      {recentFiles.map((file, i) => (
        <FileCreatedCard key={`${file.path}-${i}`} filePath={file.path} fileType={file.type} />
      ))}
    </div>
  )}

  {activeTab.kind === 'artifact' && activeTab.artifact && (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ArtifactPanel
        artifact={activeTab.artifact}
        onApprove={handleApprove}
        onRevise={handleRevise}
        onContentLoaded={(content) => upsertArtifactTab(prev => prev ? { ...prev, content } : prev, false)}
        tenantSlug={tenantSlug}
      />
    </div>
  )}

  {activeTab.kind === 'knowledge' && <KnowledgeBaseSection />}
</div>
```

Note: `activeTab.kind === 'file'` and `activeTab.kind === 'gallery'` render nothing yet — Task 6 fills those branches in.

- [ ] **Step 6: Verify existing artifact flow by hand**

Run: `cd apps/web && pnpm dev`, open a conversation, ask the agent to draft a PRD, and confirm: the Canvas pane auto-opens, an "Artifact" tab appears showing the streaming PRD, Approve/Revise still work, and the Knowledge Base tab still renders. This is a UI-heavy refactor with no jsdom test harness in this repo (see Global Constraints) — manual verification is the sign-off for this task.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/canvas/Canvas.tsx
git commit -m "refactor(media-workspace): unify Canvas activeTab into tabs[] model"
```

---

## Task 6: `AssetGallery` component

**Files:**
- Create: `apps/web/components/platform/canvas/AssetGallery.tsx`
- Modify: `apps/web/components/platform/canvas/Canvas.tsx`

**Interfaces:**
- Consumes: `useConversationAssets` (Task 3), `Asset` (Task 1), `CanvasTab` (Task 4).
- Produces: `AssetGallery({ conversationId, filterAssetId, onCardClick }: { conversationId: string; filterAssetId?: string; onCardClick: (asset: Asset, allAssets: Asset[]) => void })`. `filterAssetId` scopes the grid to a single asset when rendered inside a `file` tab (per spec: "same underlying gallery component"). `onCardClick` is consumed by Task 7 to open the lightbox.

- [ ] **Step 1: Write the gallery component**

```tsx
// apps/web/components/platform/canvas/AssetGallery.tsx
'use client';

import { FileVideo, FileAudio, FileImage, FileText, File as FileIcon } from 'lucide-react';
import { useConversationAssets } from '@/hooks/useConversationAssets';
import type { Asset, AssetType } from '@/types/assets';

interface AssetGalleryProps {
  conversationId: string;
  filterAssetId?: string;
  onCardClick: (asset: Asset, allAssets: Asset[]) => void;
}

const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  file: FileIcon,
  prd: FileText,
  roadmap: FileText,
  tasks: FileText,
};

const TYPE_BADGES: Record<AssetType, string> = {
  video: 'MP4',
  audio: 'MP3',
  image: 'IMG',
  markdown: 'MD',
  file: 'FILE',
  prd: 'PRD',
  roadmap: 'ROADMAP',
  tasks: 'TASKS',
};

function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const Icon = TYPE_ICONS[asset.type];
  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col rounded-xl border border-border/60 bg-muted/20 overflow-hidden text-left hover:border-primary/40 transition-colors"
    >
      <div className="relative aspect-video bg-muted flex items-center justify-center">
        {asset.thumbnailUrl ? (
          <img src={asset.thumbnailUrl} alt={asset.filename} className="w-full h-full object-cover" />
        ) : (
          <Icon className="h-8 w-8 text-muted-foreground/60" />
        )}
        <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
          {TYPE_BADGES[asset.type]}
        </span>
      </div>
      <div className="px-2.5 py-2">
        <p className="text-xs font-medium truncate">{asset.filename}</p>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
      </div>
    </button>
  );
}

export function AssetGallery({ conversationId, filterAssetId, onCardClick }: AssetGalleryProps) {
  const { assets, isLoading } = useConversationAssets(conversationId);
  const visible = filterAssetId ? assets.filter(a => a.id === filterAssetId) : assets;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Generate in ⏱ Chat History</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button className="hover:text-foreground">Filter</button>
          <button className="hover:text-foreground">View</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing generated in this conversation yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map(asset => (
              <AssetCard key={asset.id} asset={asset} onClick={() => onCardClick(asset, assets)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `Canvas.tsx`'s tab content switch**

In the tab-content section from Task 5 Step 5, add branches for `gallery` and `file` kinds:

```tsx
{activeTab.kind === 'gallery' && (
  <AssetGallery conversationId={agentId ?? ''} onCardClick={() => { /* wired to the lightbox in Task 7 */ }} />
)}

{activeTab.kind === 'file' && activeTab.asset && (
  <AssetGallery conversationId={agentId ?? ''} filterAssetId={activeTab.asset.id} onCardClick={() => { /* wired to the lightbox in Task 7 */ }} />
)}
```

Add the import: `import { AssetGallery } from './AssetGallery';`

> Note: `agentId` is Canvas's per-agent identifier, not a conversation id — the gallery needs the actual `conversationId`. `CanvasProps` gains a `conversationId: string` prop in this step, threaded from `page.tsx`'s existing `conversationId` value:

```ts
// Canvas.tsx — CanvasProps
interface CanvasProps {
  isOpen: boolean;
  isExpanded?: boolean;
  onActivity?: () => void;
  onExpand?: () => void;
  tenantSlug: string;
  flushPending: () => void;
  agentId?: string;
  conversationId: string;
}
```

```ts
// Canvas.tsx — function signature
export function Canvas({ isOpen, isExpanded, onActivity, onExpand, tenantSlug, flushPending, agentId, conversationId }: CanvasProps) {
```

Then use `conversationId` (not `agentId`) in both `AssetGallery` calls above.

```tsx
// apps/web/app/[tenant]/dashboard/chat/page.tsx — Canvas call site, add the prop:
<Canvas isOpen={isCanvasOpen} isExpanded={isCanvasExpanded} onExpand={toggleExpand} onActivity={noopActivity} tenantSlug={tenantSlug} flushPending={flushPending} agentId={selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id} conversationId={conversationId ?? ''} />
```

- [ ] **Step 3: Manual verification**

Run: `cd apps/web && pnpm dev`. Open a conversation that has at least one uploaded image/video and one approved PRD. Click the `+` region isn't wired yet (Task 10), so temporarily call `openGalleryTab()` from a dev-only button or React DevTools to confirm the grid renders real cards (thumbnail/badge/filename) sourced from `GET /api/v1/conversations/:id/assets`, not hardcoded data.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/canvas/AssetGallery.tsx \
        apps/web/components/platform/canvas/Canvas.tsx \
        "apps/web/app/[tenant]/dashboard/chat/page.tsx"
git commit -m "feat(media-workspace): add AssetGallery grid component"
```

---

## Task 7: `AssetLightbox` shell + video mode

**Files:**
- Create: `apps/web/components/platform/canvas/AssetLightbox.tsx`
- Create: `apps/web/components/platform/canvas/lightbox/VideoPreview.tsx`
- Modify: `apps/web/components/platform/canvas/Canvas.tsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogContent` (`apps/web/components/ui/dialog.tsx`); `Asset` (Task 1); `GET /api/v1/files/:fileId/presigned-url` (existing endpoint, same one `MessageThread.tsx:77-80` already uses).
- Produces: `AssetLightbox({ asset, allAssets, onClose, onNavigate }: { asset: Asset; allAssets: Asset[]; onClose: () => void; onNavigate: (asset: Asset) => void })`. `VideoPreview({ url }: { url: string })`.

- [ ] **Step 1: Write `VideoPreview`**

```tsx
// apps/web/components/platform/canvas/lightbox/VideoPreview.tsx
'use client';

export function VideoPreview({ url }: { url: string }) {
  return (
    <video
      src={url}
      controls
      controlsList="nodownload"
      className="max-h-full max-w-full rounded-lg"
    />
  );
}
```

(The scrubber/play/pause/speed/volume/fullscreen controls required by the spec come from the native `<video controls>` UI — no custom player is needed for those, matching YAGNI: build a custom control bar only if a later design pass asks for one.)

- [ ] **Step 2: Write the lightbox shell**

```tsx
// apps/web/components/platform/canvas/AssetLightbox.tsx
'use client';

import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Copy, Download } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { VideoPreview } from './lightbox/VideoPreview';
import type { Asset } from '@/types/assets';

interface AssetLightboxProps {
  asset: Asset;
  allAssets: Asset[];
  onClose: () => void;
  onNavigate: (asset: Asset) => void;
}

function useAssetUrl(asset: Asset): string | null {
  const [url, setUrl] = useState<string | null>(asset.thumbnailUrl ?? null);
  useEffect(() => {
    setUrl(asset.thumbnailUrl ?? null);
    if (!asset.fileId) return;
    api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(asset.fileId)}/presigned-url`)
      .then(res => setUrl(res.presignedUrl))
      .catch(() => {});
  }, [asset.fileId, asset.thumbnailUrl]);
  return url;
}

export function AssetLightbox({ asset, allAssets, onClose, onNavigate }: AssetLightboxProps) {
  const url = useAssetUrl(asset);
  const index = allAssets.findIndex(a => a.id === asset.id);
  const prevAsset = index > 0 ? allAssets[index - 1] : null;
  const nextAsset = index >= 0 && index < allAssets.length - 1 ? allAssets[index + 1] : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-w-none w-screen h-screen p-0 rounded-none border-0 sm:max-w-none flex flex-col">
        <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <p className="text-sm font-semibold">{asset.filename}</p>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
              <Copy className="h-4 w-4" />
            </button>
            <button onClick={onClose} className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="relative flex-1 flex items-center justify-center bg-black/5 p-6">
            {prevAsset && (
              <button
                onClick={() => onNavigate(prevAsset)}
                className="absolute left-4 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-sm hover:bg-background"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}

            {url && asset.type === 'video' && <VideoPreview url={url} />}
            {!url && <p className="text-sm text-muted-foreground">Loading preview…</p>}
            {/* audio + markdown branches land in Task 8/9 */}

            {nextAsset && (
              <button
                onClick={() => onNavigate(nextAsset)}
                className="absolute right-4 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-sm hover:bg-background"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="w-64 flex-none border-l border-border p-4 space-y-3 text-xs">
            <div>
              <p className="text-muted-foreground">Type</p>
              <p className="font-medium">{asset.type}</p>
            </div>
            {asset.size != null && (
              <div>
                <p className="text-muted-foreground">Size</p>
                <p className="font-medium">{(asset.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">Created</p>
              <p className="font-medium">{new Date(asset.createdAt).toLocaleString()}</p>
            </div>
            {url && (
              <a
                href={url}
                download={asset.filename}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 mt-2 text-primary hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Wire `onCardClick` in `Canvas.tsx` to open the lightbox**

```ts
// Canvas.tsx — add state near the other useState calls:
const [lightboxAsset, setLightboxAsset] = useState<{ asset: Asset; allAssets: Asset[] } | null>(null);
```

Replace both `onCardClick={() => { /* wired to the lightbox in Task 7 */ }}` call sites from Task 6 Step 2 with:

```tsx
onCardClick={(asset, allAssets) => setLightboxAsset({ asset, allAssets })}
```

Add, right after the closing `</div>` of the Canvas root `<div className="flex flex-col h-full ...">`:

```tsx
{lightboxAsset && (
  <AssetLightbox
    asset={lightboxAsset.asset}
    allAssets={lightboxAsset.allAssets}
    onClose={() => setLightboxAsset(null)}
    onNavigate={(asset) => setLightboxAsset(prev => prev ? { asset, allAssets: prev.allAssets } : prev)}
  />
)}
```

Add the import: `import { AssetLightbox } from './AssetLightbox';`

- [ ] **Step 4: Manual verification**

Run: `cd apps/web && pnpm dev`. Open the gallery (via the dev-only trigger from Task 6), click a video card, confirm the lightbox opens full-screen with a working native video player, sidebar metadata, and that the left/right arrows step between assets without closing the overlay.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/canvas/AssetLightbox.tsx \
        apps/web/components/platform/canvas/lightbox/VideoPreview.tsx \
        apps/web/components/platform/canvas/Canvas.tsx
git commit -m "feat(media-workspace): add AssetLightbox shell with video preview"
```

---

## Task 8: `MarkdownViewer` extraction + wiring

**Files:**
- Create: `apps/web/components/platform/canvas/MarkdownViewer.tsx`
- Modify: `apps/web/components/platform/canvas/ArtifactPanel.tsx`
- Modify: `apps/web/components/platform/canvas/AssetLightbox.tsx`

**Interfaces:**
- Produces: `MarkdownViewer({ content }: { content: string })`. Consumed by `ArtifactPanel` (replacing its hand-rolled `MarkdownLine`) and by the lightbox's markdown branch.

- [ ] **Step 1: Write `MarkdownViewer`**

```tsx
// apps/web/components/platform/canvas/MarkdownViewer.tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        pre: ({ children }) => <pre className="bg-muted p-4 rounded-lg overflow-x-auto mb-3 text-sm font-mono">{children}</pre>,
        code: ({ className, children, ...props }: any) => !className
          ? <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
          : <code className={className} {...props}>{children}</code>,
        h1: ({ children }) => <h1 className="font-bold text-base mb-2 mt-3">{children}</h1>,
        h2: ({ children }) => <h2 className="font-semibold text-sm mb-2 mt-3">{children}</h2>,
        h3: ({ children }) => <h3 className="font-semibold text-sm mb-1.5 mt-2">{children}</h3>,
        a: ({ href, children }) => <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>,
        blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 italic mb-3">{children}</blockquote>,
        table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-left border-collapse">{children}</table></div>,
        thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
        th: ({ children }) => <th className="px-2 py-1.5 font-semibold text-xs">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1.5 border-t border-border/50 text-xs">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
```

- [ ] **Step 2: Wire it into `ArtifactPanel.tsx`**

Delete the `MarkdownLine` function (`ArtifactPanel.tsx:41-58`) and its import usage. Replace the content block:

```tsx
{artifact.content.split('\n').map((line, i) => (
  <MarkdownLine key={i} line={line} />
))}
```

with:

```tsx
<MarkdownViewer content={artifact.content} />
```

Add the import: `import { MarkdownViewer } from './MarkdownViewer';`

- [ ] **Step 3: Wire it into `AssetLightbox.tsx`**

In the center content area, add a branch alongside the existing video one:

```tsx
{url && asset.type === 'video' && <VideoPreview url={url} />}
{(asset.type === 'markdown' || asset.type === 'prd' || asset.type === 'roadmap' || asset.type === 'tasks') && (
  <div className="w-full h-full overflow-y-auto text-sm px-2">
    <MarkdownViewer content={markdownContent} />
  </div>
)}
```

`markdownContent` needs sourcing: for `markdown`-type file assets, fetch the raw text from the presigned URL (`useAssetUrl`'s `url`); for `prd`/`roadmap`/`tasks`, fetch from the existing entity endpoints exactly as `ArtifactPanel.tsx:71-93` already does. Add this alongside `useAssetUrl`:

```ts
function useMarkdownContent(asset: Asset, fileUrl: string | null): string {
  const [content, setContent] = useState('');
  useEffect(() => {
    setContent('');
    let cancelled = false;
    if (asset.type === 'markdown' && fileUrl) {
      fetch(fileUrl).then(r => r.text()).then(text => { if (!cancelled) setContent(text); }).catch(() => {});
    } else if (asset.type === 'prd' && asset.entityId) {
      api.get<{ data: { content: string } }>(`/api/v1/prds/${asset.entityId}`)
        .then(res => { if (!cancelled) setContent(res.data?.content ?? ''); })
        .catch(() => {});
    } else if (asset.type === 'roadmap' && asset.entityId) {
      Promise.all([
        api.get<{ data: { title: string; description?: string | null } }>(`/api/v1/plans/${asset.entityId}`),
        api.get<{ data: Array<{ title: string; description?: string | null; priority: string }> }>(`/api/v1/plans/${asset.entityId}/milestones`),
      ]).then(([planRes, msRes]) => {
        if (cancelled) return;
        const plan = planRes.data;
        const milestones = msRes.data ?? [];
        const lines: string[] = [`# ${plan.title}`];
        if (plan.description) lines.push(`\n${plan.description}\n`);
        milestones.forEach((m, i) => {
          lines.push(`### ${i + 1}. ${m.title}`);
          lines.push(`**Priority:** ${m.priority}`);
          if (m.description) lines.push(`\n${m.description}`);
        });
        setContent(lines.join('\n'));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [asset.id, asset.type, asset.entityId, fileUrl]);
  return content;
}
```

`useMarkdownContent` guards against the same out-of-order-response race as `useAssetUrl` (Task 7) — a `cancelled` flag set in the effect's cleanup, checked before every `setContent` call, so navigating to a new asset before an in-flight fetch resolves can't overwrite the newer asset's content with stale data.

and inside `AssetLightbox`, right after `const url = useAssetUrl(asset);`:

```ts
const markdownContent = useMarkdownContent(asset, url);
```

- [ ] **Step 4: Manual verification**

Run: `cd apps/web && pnpm dev`. Open the lightbox on a PRD-type asset and confirm real headings/bold/tables render (not raw `#`/`**` text, not a `<pre>` block).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/canvas/MarkdownViewer.tsx \
        apps/web/components/platform/canvas/ArtifactPanel.tsx \
        apps/web/components/platform/canvas/AssetLightbox.tsx
git commit -m "feat(media-workspace): extract MarkdownViewer, wire into ArtifactPanel and lightbox"
```

---

## Task 9: `AudioPreview` lightbox mode

**Files:**
- Create: `apps/web/components/platform/canvas/lightbox/AudioPreview.tsx`
- Modify: `apps/web/components/platform/canvas/AssetLightbox.tsx`

**Interfaces:**
- Produces: `AudioPreview({ url }: { url: string })`.

- [ ] **Step 1: Write `AudioPreview`**

```tsx
// apps/web/components/platform/canvas/lightbox/AudioPreview.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, RotateCw } from 'lucide-react';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioPreview({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [url]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.pause(); else audio.play();
    setIsPlaying(!isPlaying);
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-md">
      <audio ref={audioRef} src={url} />
      <div className="w-full h-16 rounded-lg bg-muted flex items-center px-3 gap-0.5 overflow-hidden">
        {Array.from({ length: 48 }).map((_, i) => (
          <div
            key={i}
            className={`flex-1 rounded-full ${i / 48 < progress ? 'bg-primary' : 'bg-border'}`}
            style={{ height: `${20 + Math.sin(i * 0.7) * 15}px` }}
          />
        ))}
      </div>
      <div className="flex items-center gap-4">
        <button onClick={() => skip(-10)} className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button onClick={togglePlay} className="h-11 w-11 flex items-center justify-center rounded-full bg-primary text-primary-foreground">
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
        </button>
        <button onClick={() => skip(10)} className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50">
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{formatTime(currentTime)} / {formatTime(duration)}</p>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `AssetLightbox.tsx`**

```tsx
{url && asset.type === 'video' && <VideoPreview url={url} />}
{url && asset.type === 'audio' && <AudioPreview url={url} />}
```

Add the import: `import { AudioPreview } from './lightbox/AudioPreview';`

- [ ] **Step 3: Manual verification**

Run: `cd apps/web && pnpm dev`. Open the lightbox on an audio asset, confirm play/pause, the ±10s buttons move `currentTime`, and the time/duration label updates live.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/canvas/lightbox/AudioPreview.tsx \
        apps/web/components/platform/canvas/AssetLightbox.tsx
git commit -m "feat(media-workspace): add audio lightbox mode"
```

---

## Task 10: `CanvasTabStrip` — multi-tab management UI

**Files:**
- Create: `apps/web/components/platform/canvas/CanvasTabStrip.tsx`
- Modify: `apps/web/components/platform/canvas/Canvas.tsx`

**Interfaces:**
- Produces: `CanvasTabStrip({ tabs, activeTabId, onSelect, onClose, onOpenGallery }: { tabs: CanvasTab[]; activeTabId: string; onSelect: (id: string) => void; onClose: (id: string) => void; onOpenGallery: () => void })`.
- Consumes: `CanvasTab` (Task 4).

- [ ] **Step 1: Write the tab strip**

```tsx
// apps/web/components/platform/canvas/CanvasTabStrip.tsx
'use client';

import { Plus, X, FileText, BookOpen, Film, LayoutGrid } from 'lucide-react';
import type { CanvasTab } from './types';

const TAB_ICONS: Record<CanvasTab['kind'], React.ElementType> = {
  artifact: FileText,
  knowledge: BookOpen,
  file: Film,
  gallery: LayoutGrid,
};

interface CanvasTabStripProps {
  tabs: CanvasTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpenGallery: () => void;
}

export function CanvasTabStrip({ tabs, activeTabId, onSelect, onClose, onOpenGallery }: CanvasTabStripProps) {
  return (
    <div className="flex-none flex items-stretch border-b border-border overflow-x-auto">
      <button
        onClick={onOpenGallery}
        title="Open Chat History"
        className="flex-none w-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 border-r border-border"
      >
        <Plus className="h-4 w-4" />
      </button>
      {tabs.map(tab => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`group flex-none flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
              isActive ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onSelect(tab.id)}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-[120px]">{tab.title}</span>
            {tab.kind === 'artifact' && tab.artifact?.isStreaming && (
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            )}
            {tab.closeable && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-muted shrink-0"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Replace the inline tab-bar JSX in `Canvas.tsx` from Task 5**

```tsx
<CanvasTabStrip
  tabs={tabs}
  activeTabId={activeTabId}
  onSelect={setActiveTabId}
  onClose={closeTab}
  onOpenGallery={openGalleryTab}
/>
```

Add the import: `import { CanvasTabStrip } from './CanvasTabStrip';`

- [ ] **Step 3: Manual verification**

Run: `cd apps/web && pnpm dev`. Confirm: clicking `+` opens/focuses the "Chat History" tab; opening a PRD and a file tab shows three tabs total (Chat History, Artifact, the file) with correct icons; each closeable tab shows an `x` on hover that removes it and falls back to an adjacent tab; the pinned Knowledge Base tab has no `x`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/canvas/CanvasTabStrip.tsx apps/web/components/platform/canvas/Canvas.tsx
git commit -m "feat(media-workspace): add CanvasTabStrip with closeable multi-tab management"
```

---

## Task 11: Inline attachment cards open a tab instead of expanding

**Files:**
- Create: `apps/web/components/platform/chat/InlineAttachmentCard.tsx`
- Modify: `apps/web/components/platform/chat/MessageItem.tsx`

**Interfaces:**
- Consumes: `MessageAttachment` (`apps/web/components/platform/chat/types.ts`), `Asset`/`AssetType` (Task 1), `window.__openCanvas` / `window.__canvasUpdate('asset_open', { asset })` bridge (Task 5).
- Produces: `InlineAttachmentCard({ file, url }: { file: MessageAttachment; url: string | null })`.

- [ ] **Step 1: Write the card**

```tsx
// apps/web/components/platform/chat/InlineAttachmentCard.tsx
'use client';

import { FileVideo, FileAudio, FileImage, FileText } from 'lucide-react';
import type { MessageAttachment } from './types';
import type { Asset, AssetType } from '@/types/assets';

function classifyMimeType(mimeType: string, filename: string): AssetType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'text/markdown' || filename.toLowerCase().endsWith('.md')) return 'markdown';
  return 'file';
}

const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  file: FileText,
  prd: FileText,
  roadmap: FileText,
  tasks: FileText,
};

interface InlineAttachmentCardProps {
  file: MessageAttachment;
  url: string | null;
}

export function InlineAttachmentCard({ file, url }: InlineAttachmentCardProps) {
  const type = classifyMimeType(file.type, file.name);
  const Icon = TYPE_ICONS[type];

  const handleClick = () => {
    if (!file.fileId) return; // nothing to open in the right pane without a persisted reference
    const asset: Asset = {
      id: file.fileId,
      type,
      filename: file.name,
      mimeType: file.type,
      thumbnailUrl: url ?? file.previewUrl,
      size: file.size,
      createdAt: new Date().toISOString(),
      sourceMessageId: '',
      fileId: file.fileId,
    };
    (window as any).__openCanvas?.();
    (window as any).__canvasUpdate?.('asset_open', { asset });
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2.5 px-2.5 py-2 bg-muted/40 border border-border/40 rounded-xl text-left hover:bg-muted/70 transition-colors min-w-[160px] max-w-[220px]"
    >
      <div className="h-8 w-8 rounded-lg bg-background border border-border/40 flex items-center justify-center shrink-0 overflow-hidden">
        {(type === 'image') && url ? (
          <img src={url} alt={file.name} className="h-full w-full object-cover" />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium truncate">{file.name}</p>
        <p className="text-[9px] text-muted-foreground uppercase tracking-wide">{type}</p>
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Replace `MessageItem.tsx`'s expand-inline block**

Replace the entire `message.attachments.map(...)` body (`MessageItem.tsx:158-200`, the image/video/audio/pdf/generic-file branches) with:

```tsx
{message.attachments.map((file, index) => {
  const url = (file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null;
  return <InlineAttachmentCard key={file.id ?? `att-${index}`} file={file} url={url} />;
})}
```

Add the import: `import { InlineAttachmentCard } from './InlineAttachmentCard';`. The now-unused `MessageAudioPlayer` import and any other now-dead imports in `MessageItem.tsx` (check `FileText` usage elsewhere in the file before removing it) should be cleaned up.

- [ ] **Step 3: Manual verification**

Run: `cd apps/web && pnpm dev`. Send a message with an image attachment and one with a PDF attachment. Confirm both now render as a compact card (not an inflated inline image / open-in-new-tab link), and clicking either opens/focuses a Canvas file tab showing that asset — image thumbnail visible, PDF downloadable from the sidebar.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/chat/InlineAttachmentCard.tsx apps/web/components/platform/chat/MessageItem.tsx
git commit -m "feat(media-workspace): open inline attachment cards as Canvas tabs instead of expanding"
```

---

## Task 12: "Add to task" — hover action wired into the compose box

**Files:**
- Modify: `apps/web/components/platform/chat/useFileUpload.ts`
- Modify: `apps/web/components/platform/chat/ChatInput.tsx`
- Modify: `apps/web/components/platform/canvas/AssetGallery.tsx`
- Test: `apps/web/components/platform/chat/useFileUpload.test.ts`

**Interfaces:**
- Consumes: `Asset` (Task 1), `Attachment` (`apps/web/types/agent-events.ts`).
- Produces: `useFileUpload()` gains `addAttachment(asset: Asset): void`. `ChatInput.tsx` registers `window.__addComposeAttachment = uploader.addAttachment` (mirroring `page.tsx`'s existing `window.__openCanvas` bridge pattern) so `AssetGallery`, which lives in the sibling Canvas pane, can reach into the compose box's local state without lifting it to `page.tsx`.

- [ ] **Step 1: Write the failing test for the mapping logic**

```ts
// apps/web/components/platform/chat/useFileUpload.test.ts
import { describe, it, expect } from 'vitest';
import { assetToAttachment } from './useFileUpload';
import type { Asset } from '@/types/assets';

describe('assetToAttachment', () => {
  it('maps a video Asset into the Attachment shape used by AttachmentStrip', () => {
    const asset: Asset = {
      id: 'file-1',
      type: 'video',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      thumbnailUrl: 'https://example.com/clip.mp4',
      size: 2048,
      createdAt: '2026-08-01T00:00:00Z',
      sourceMessageId: 'm1',
      fileId: 'file-1',
    };

    expect(assetToAttachment(asset)).toEqual({
      fileId: 'file-1',
      name: 'clip.mp4',
      type: 'video/mp4',
      size: 2048,
      previewUrl: 'https://example.com/clip.mp4',
    });
  });

  it('falls back to the asset id as fileId for artifact-type assets', () => {
    const asset: Asset = {
      id: 'prd-1',
      type: 'prd',
      filename: 'Onboarding PRD',
      createdAt: '2026-08-01T00:00:00Z',
      sourceMessageId: 'm2',
      entityId: 'prd-1',
    };

    expect(assetToAttachment(asset).fileId).toBe('prd-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run components/platform/chat/useFileUpload.test.ts`
Expected: FAIL — `assetToAttachment` is not exported from `./useFileUpload`

- [ ] **Step 3: Add `assetToAttachment` and `addAttachment` to `useFileUpload.ts`**

```ts
// apps/web/components/platform/chat/useFileUpload.ts
// add near the top-level exports:
import type { Asset } from '@/types/assets';

export function assetToAttachment(asset: Asset): Attachment {
  return {
    fileId: asset.fileId ?? asset.id,
    name: asset.filename,
    type: asset.mimeType ?? 'application/octet-stream',
    size: asset.size,
    previewUrl: asset.thumbnailUrl,
  };
}
```

Inside `useFileUpload()`, add alongside `removeAttachment`:

```ts
const addAttachment = (asset: Asset) => {
  setAttachments(prev => prev.some(a => a.fileId === asset.fileId || a.fileId === asset.id)
    ? prev
    : [...prev, assetToAttachment(asset)]);
};
```

Add `addAttachment` to the hook's return object:

```ts
return {
  attachments,
  pendingUpload,
  isUploading,
  removeAttachment,
  addAttachment,
  handleFileChange,
  uploadAudio,
  clearAttachments,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run components/platform/chat/useFileUpload.test.ts`
Expected: PASS

- [ ] **Step 5: Register the window bridge in `ChatInput.tsx`**

Add, near the other hook calls in `ChatInput`:

```ts
useEffect(() => {
  (window as any).__addComposeAttachment = uploader.addAttachment;
  return () => { delete (window as any).__addComposeAttachment; };
}, [uploader.addAttachment]);
```

(`useEffect` is already imported in `ChatInput.tsx:10`.)

- [ ] **Step 6: Wire the hover "+ Add to task" button in `AssetGallery.tsx`**

Replace `AssetCard`'s body to add a hover overlay:

```tsx
function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const Icon = TYPE_ICONS[asset.type];
  return (
    <div className="group relative flex flex-col rounded-xl border border-border/60 bg-muted/20 overflow-hidden">
      <button onClick={onClick} className="text-left hover:border-primary/40 transition-colors">
        <div className="relative aspect-video bg-muted flex items-center justify-center">
          {asset.thumbnailUrl ? (
            <img src={asset.thumbnailUrl} alt={asset.filename} className="w-full h-full object-cover" />
          ) : (
            <Icon className="h-8 w-8 text-muted-foreground/60" />
          )}
          <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
            {TYPE_BADGES[asset.type]}
          </span>
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
            <button
              onClick={(e) => {
                e.stopPropagation();
                (window as any).__addComposeAttachment?.(asset);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity px-3 py-1.5 rounded-full bg-background text-foreground text-xs font-medium shadow-sm hover:bg-muted"
            >
              + Add to task
            </button>
          </div>
        </div>
        <div className="px-2.5 py-2">
          <p className="text-xs font-medium truncate">{asset.filename}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
        </div>
      </button>
    </div>
  );
}
```

(The outer element changes from `<button>` to `<div>` with an inner `<button onClick={onClick}>` since the hover button must be a separate, independently-clickable target nested inside — a `<button>` cannot contain another `<button>`.)

- [ ] **Step 7: Manual verification**

Run: `cd apps/web && pnpm dev`. Open the Chat History gallery, hover a card, click "+ Add to task", and confirm a thumbnail chip appears above the compose textarea with a working "x" remove button — the same visual treatment as a manually uploaded file — and that sending the message includes it as a real attachment (no re-upload network call fires).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/platform/chat/useFileUpload.ts \
        apps/web/components/platform/chat/useFileUpload.test.ts \
        apps/web/components/platform/chat/ChatInput.tsx \
        apps/web/components/platform/canvas/AssetGallery.tsx
git commit -m "feat(media-workspace): wire gallery Add to task into the compose box"
```

---

## Self-Review Notes

- **Spec coverage:** §1 split tab strip → Tasks 4/5/10. §2 Chat History/gallery view → Tasks 2/3/6. §3 Add to task → Task 12. §4 lightbox (video/audio/markdown) → Tasks 7/8/9. The "click a card in chat opens as a tab" requirement → Task 11 (media/file attachments) + already-existing `ChatArtifactCard` (artifacts), preserved unchanged through the Task 5 refactor.
- **Type consistency verified:** `Asset`/`AssetType` (Task 1) match the backend `AssetDTO` shape (Task 2) field-for-field; `CanvasTab`/`CanvasTabKind` (Task 4) are the single model consumed by Tasks 5, 6, 10; `assetToAttachment` (Task 12) maps into the pre-existing `Attachment` type (`apps/web/types/agent-events.ts`) unchanged, so `AttachmentStrip.tsx` needs no edits.
- **Placeholder scan:** no TBD/TODO markers; every code step is complete, runnable code, not a description.
