# Media Workspace — Design Spec

**Date:** 2026-08-19
**Status:** Approved for planning

## Summary

Add a Higgsfield-Supercomputer-style "media workspace" to the chat panel: a
right-pane tab strip where generated/uploaded assets open as tabs, a
"Chat History" gallery view of everything generated in the conversation, a
type-aware full-screen lightbox (video / audio / markdown), and an
"Add to task" action that pre-populates the compose box's attachment state
from a gallery asset.

This is **not** a net-new right pane. The codebase already has a right-pane
component, `Canvas` (`apps/web/components/platform/canvas/Canvas.tsx`),
toggled from `ChatHeader.tsx`, with an existing two-tab strip (`artifact`,
`knowledge`) and an existing pattern — `ChatArtifactCard` clicking through a
`window.__openCanvas()` / `window.__canvasUpdate()` bridge — for "clicking a
card in the message thread opens content in the right pane instead of
expanding inline." This spec extends Canvas rather than duplicating it.

## Existing building blocks (confirmed via codebase survey)

| Need | Existing piece | Reused as |
|---|---|---|
| Right pane + toggle | `Canvas.tsx`, `useCanvas.ts`, `ChatHeader.tsx` `PanelRight` button | Base pane; tab model extended |
| "Click card → open in right pane" | `ChatArtifactCard.tsx` + `window.__openCanvas`/`__canvasUpdate` bridge (also called from `page.tsx`, `Canvas.tsx`, `useCanvas.ts` — 4 files total, contained) | Bridge extended to open file/gallery tabs, not just replace the artifact tab |
| Markdown rendering | `ArtifactPanel.tsx`'s hand-rolled `MarkdownLine` renderer | Generalized into a standalone `MarkdownViewer`, used by both the artifact tab and the lightbox |
| Compose attachment state | `useFileUpload.ts` (`attachments`, `removeAttachment`, `clearAttachments`) + `AttachmentStrip.tsx` (thumbnail chips w/ "x") | Gains `addAttachment(asset)`; `AttachmentStrip` unchanged |
| Full-screen overlay primitive | `apps/web/components/ui/dialog.tsx` (shadcn/Radix) | Scaffolding for the new lightbox shell |

**Confirmed gaps (net-new work):**
- No lightbox/type-switched preview component exists anywhere in `apps/web`.
- No per-conversation asset aggregation — `attachments` and `artifactRef` are
  `jsonb` columns on the `messages` table (`products/agent-platform/packages/schema/conversations.ts`);
  there is no endpoint that lists "everything generated in this chat."
- `FileCreatedCard.tsx` (renders non-artifact media — image/video/audio/file)
  is currently passive/static, only used inside Canvas's own ephemeral
  (non-persisted) "Recent Files" list — it has no click-to-open behavior today.
- `ArtifactRef.type` is a closed union (`'prd' | 'roadmap' | 'tasks'`) with no
  media types.

## Decisions made during design

- **Scope of "asset":** unified — PRD/roadmap/task artifacts AND generated
  media (video/audio/image/file) both appear as gallery cards and both open
  through the same tab/lightbox machinery. `ChatArtifactCard`'s dedicated
  behavior is absorbed into the general "card → tab" flow, not kept as a
  separate parallel path.
- **Tab model:** unified. `Canvas`'s `activeTab: 'artifact' | 'knowledge'`
  closed union is replaced with a generic `tabs: CanvasTab[]` +
  `activeTabId` array. `artifact` and `gallery`/`file` tabs are all instances
  of the same model.
- **`knowledge` tab:** stays pinned — always present, non-closeable — since
  it isn't conversation-generated content and doesn't fit the closeable-tab
  idea. Everything else (artifact tabs, file tabs, the Chat History tab) is
  closeable and reopenable.
- **Asset data source:** new backend endpoint, not client-side derivation
  from already-loaded messages — real data from day one, and the aggregation
  logic belongs server-side since it must eventually cover paginated/older
  messages not in the client's loaded window.
- **No DB migration.** The endpoint derives `Asset[]` by reading existing
  `attachments`/`artifactRef` jsonb columns; it does not introduce a new
  table.

## Data model

```ts
// apps/web/types (and mirrored/validated on the API side)
type AssetType =
  | 'video' | 'audio' | 'image' | 'markdown' | 'file'
  | 'prd' | 'roadmap' | 'tasks'

type Asset = {
  id: string
  type: AssetType
  filename: string
  thumbnailUrl?: string
  size?: number
  createdAt: string
  sourceMessageId: string
  fileId?: string           // present for uploaded/generated files -> feeds Attachment
  artifactPayload?: unknown // present for prd/roadmap/tasks -> feeds MarkdownViewer / ArtifactPanel
}
```

`Asset` is the FE-facing shape used by the gallery, lightbox, and tab model.
It supersedes `ArtifactRef` as what components consume; the backend keeps
writing the existing `attachments`/`artifactRef` jsonb columns unchanged.

## Backend

`GET /conversations/:id/assets` — new route in
`products/agent-platform/packages/api`, mounted alongside the existing
conversation routes (same tenant-scoping, same auth middleware chain as
`messages.ts`). Scans the conversation's messages, maps each message's
`attachments[]` and `artifactRef` into zero or more `Asset` entries, sorted
by `createdAt` ascending. Purely a derived read — no writes, no new table.

## Canvas tab model

`useCanvas.ts` state changes from a closed `activeTab` union to:

```ts
type CanvasTabKind = 'artifact' | 'knowledge' | 'file' | 'gallery'

type CanvasTab = {
  id: string
  kind: CanvasTabKind
  title: string
  icon: LucideIcon
  payload: unknown   // Asset for file/gallery-single-asset tabs; existing artifact payload for 'artifact'
  closeable: boolean // false only for the pinned 'knowledge' tab
}

tabs: CanvasTab[]
activeTabId: string
```

`knowledge` is seeded once on mount, `closeable: false`. A "Chat History"
tab (`kind: 'gallery'`) is always openable via the `+` button or a persistent
shortcut, but is not force-pinned — closing it just means reopening it later,
same as a file tab.

The `window.__canvasUpdate` bridge (called today only from
`ChatArtifactCard.tsx`, `page.tsx`, `Canvas.tsx`, `useCanvas.ts`) is extended
to open-or-focus a tab by `(kind, payload)` instead of unconditionally
replacing the single `artifact` tab's content — if a tab for that
asset/artifact already exists, focus it; otherwise open a new one. This
preserves the existing call sites' intent ("open this in the right pane")
while generalizing what "this" can be.

## Gallery component

New `AssetGallery.tsx`. Rendered by:
- the "Chat History" tab (`kind: 'gallery'`, no filter) — full asset list
- any individual file tab (`kind: 'file'`) — same component, scoped to that
  one asset, per the original spec's "same underlying gallery component"

Fetches `GET /conversations/:id/assets` (cached per conversation; refetched
on new-asset-producing events, e.g. `file_created` websocket messages Canvas
already listens for). Renders:
- Header: "Generate in ⏱ Chat History" + Filter / View controls (top-right)
- Responsive card grid: thumbnail (video frame / waveform icon / doc icon by
  type), type badge (MP4/MD/MP3/...), filename, type label
- Hover: centered "+ Add to task" overlay button
- Click (not the hover button): opens `AssetLightbox` positioned at that
  asset, with the full `Asset[]` list for prev/next navigation

## Lightbox

New `AssetLightbox.tsx`, built on the existing `Dialog` primitive
(`apps/web/components/ui/dialog.tsx`) as a full-screen overlay rather than a
new bespoke portal. Single shared shell for all types:

- Top-left: filename + type label
- Top-right: duplicate/split icon, close (×)
- Left/right arrows: navigate the adjacent `Asset` in the list already held
  by the gallery — no refetch
- Right sidebar: Type, Size (if applicable), Created date, Download button
- Center content, type-switched:
  - **video** — full player: scrubber, play/pause, speed, volume, fullscreen
  - **audio** — waveform visualization, play button, time/duration, ±10s skip
  - **markdown** (`markdown`, `prd`, `roadmap`, `tasks`) — `MarkdownViewer`,
    a generalized extraction of `ArtifactPanel.tsx`'s `MarkdownLine` renderer
    (real headings/bold/italic/tables, not raw text or `<pre>`)

## Add-to-task wiring

`useFileUpload.ts` gains:

```ts
addAttachment(asset: Asset): void
```

Maps `Asset` → the existing `Attachment` shape (`fileId`, `name`, `type`,
`size`, `previewUrl`) and pushes it into the existing `attachments` array —
no upload call, no new component. `AttachmentStrip.tsx` renders it exactly
as it renders a manually-uploaded file, "x" removes it via the existing
`removeAttachment`, unchanged.

## Phased build order

1. **Foundation** — backend `GET /conversations/:id/assets` + `Asset` type +
   Canvas tab-model refactor (`activeTab` union → `tabs[]`/`activeTabId`,
   `window.__canvasUpdate` generalized to open-or-focus). Existing
   artifact-open behavior must keep working through the new model — this is
   the riskiest step since it touches the 4 files sharing the window bridge.
2. **Gallery + video lightbox** — `AssetGallery.tsx`, `AssetLightbox.tsx`
   with video-only center content first (video is most of current content).
3. **Markdown + audio lightbox modes** — `MarkdownViewer` extraction from
   `ArtifactPanel`; new audio waveform/controls implementation.
4. **Tab strip / multi-tab management + inline-card wiring** — `+` button,
   individually closeable tabs, Chat-History-always-available shortcut;
   give `FileCreatedCard` the click-to-open-as-tab behavior `ChatArtifactCard`
   already has, routed through the same generalized bridge.
5. **Add-to-task** — `addAttachment` on `useFileUpload.ts`, hover overlay
   wired in `AssetGallery.tsx`. Last, since it's the most orthogonal system
   (compose/upload state) and is easiest to verify once the gallery/lightbox
   already exist to source assets from.

## Conflict check: recent chat-panel work

`ChatTimelineNavigator.tsx` (commits `e03a83d`, `8b0d3da`) is absolutely
positioned at the chat column's right edge (`right-3 top-1/2`), with a
`w-64` hover popout. It sits as a sibling to Canvas today and is unaffected
by Canvas's tab-model refactor, since neither pane's width math changes
(this spec extends Canvas in place — it does not add a second toggleable
pane). No changes to `ChatTimelineNavigator.tsx`, `ClarificationCard.tsx`, or
the reasoning-trace persistence work are required by this spec.

## Testing

- Component tests for `AssetGallery` and `AssetLightbox` against mocked
  `Asset[]` fixtures covering every `AssetType`.
- Backend test for the assets endpoint against seeded messages with both
  `attachments` and `artifactRef` populated, including a message with
  neither (should contribute zero assets).
- Manual in-browser verification per phase (hover, click-through, keyboard
  nav on the lightbox, tab open/close/focus) — this feature is UI-heavy
  enough that automated coverage alone isn't sufficient sign-off.
