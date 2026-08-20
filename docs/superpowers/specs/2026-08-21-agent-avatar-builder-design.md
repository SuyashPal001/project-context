# Agent Avatar Builder — Design

## Problem

Agent identity today has two independent halves: `agent.avatarUrl` (a single static
image, uploaded via the generic `ImageUpload.tsx` → presigned-S3 flow) and
`agent.personaId` (an optional link to a curated, ops-published persona with a full
9-state animated look — see `2026-08-16-agent-personas-design.md` and its 9-state
addendum). Personas are fixed and ops-curated: end users pick from a published list,
they cannot create or customize one. Agents with no persona (`personaId IS NULL`) run
with "zero personality" and, per `agent_personas-feature-status` history, an
`avatarUrl` that today can only be an uploaded photo/image file.

Several local prototypes (`fusion_agent_avatars.html`, `agent_pixel_creator.html`,
`agent_avatar_selector.html`, untracked at repo root) explored a generative, in-browser
SVG character builder — capsule-head avatars assembled from enumerated parts (head
shape, eyes/eyewear, hairstyle/headwear, facial hair, skin/hair color, background
theme), rendered live via DOM SVG, no external image generation required.

The ask: let users build their own agent's look interactively, the way the
`fusion_agent_avatars.html` prototype demonstrates, and make it a real part of the
product rather than a standalone HTML file. Animated per-state variants ("give them
states") were raised as a future direction but are explicitly **out of scope** for this
design — see Non-goals.

## Goals

- A user can open a builder, assemble an avatar from enumerated visual options, see a
  live preview, and save it as their agent's `avatarUrl`.
- The builder is reachable per-agent, independent of what the agent does or which
  persona (if any) it has — this is an identity/cosmetic feature, not a capability
  picker.
- A user can reopen the builder later and get back the exact choices they made, not a
  blank slate.
- Zero changes to the curated-persona system: no new coupling to `personaId`,
  `animationStates`, or the ops publish gate.

## Non-goals

- Per-state animated avatars (idle/thinking/waving/etc.) for user-built agents. The
  params model below is deliberately enum-driven so state-variant poses could be
  derived from the same params later, but no state-rendering work happens in this
  design.
- Any change to how curated personas are authored, published, or gated.
- Free-text customization (e.g. custom color hex input, uploaded parts) — the palette
  and part list are fixed enums, matching the prototype.
- Server-side/headless SVG rendering. Rendering is client-side only; the server only
  ever sees the final serialized SVG string and the params JSON.

## Architecture

New component tree, additive only:

```
apps/web/components/platform/agents/avatar-builder/
  AvatarBuilderModal.tsx   — dialog, opened from AgentIdentityCard via a
                             "Build Avatar" action next to the existing upload button
  avatarParams.ts          — AvatarParams type, enums, color palettes, randomize()
                             (ported from fusion_agent_avatars.html's `params` state
                             and SKIN_COLORS/HAIR_COLORS)
  useAvatarSvg.ts           — pure function/hook: AvatarParams -> SVG markup string
                             (port of renderAvatar())
  AvatarPreview.tsx         — live preview stage (the "avatar-frame")
  AvatarControls.tsx        — option-grid + color-swatch panel
```

This sits entirely beside the existing persona system. `AgentIdentityCard.tsx` already
treats `avatarUrl` as "just an image, however it got there" (its current path is
`ImageUpload.tsx` → presigned S3); the builder is a second way to produce that same
kind of value, not a new concept the rest of the app needs to know about.

### Data model

`AvatarParams` (client-side type, and the shape persisted server-side):

```ts
interface AvatarParams {
  head: 'tall' | 'round' | 'oval';
  eyes: 'dots' | 'shades' | 'visor' | 'eyepatch';
  accessory: 'cybermohawk' | 'hightop' | 'animespikes' | 'pompadour'
    | 'curtainbangs' | 'topknot' | 'bikerhelmet' | 'bandana' | 'hood' | 'none';
  mouth: 'goatee' | 'beard' | 'stubble' | 'smile' | 'none';
  skinColor: string;   // hex, drawn from a fixed SKIN_COLORS palette
  hairColor: string;   // hex, drawn from a fixed HAIR_COLORS palette
  bgTheme: 'terracotta' | 'light' | 'space' | 'matrix' | 'transparent';
}
```

This is the same param set as `fusion_agent_avatars.html`, minus `isPixelated` (a
preview-only view toggle, not part of the identity — not persisted).

### Backend change

One migration, `products/agent-platform/packages/schema/agents.ts`:

```ts
avatarParams: jsonb('avatar_params').$type<AvatarParams>().nullable()
```

`avatarParams` is added to the existing agent-update zod schema
(`products/agent-platform/packages/api/routes/agents.crud.ts`, wherever the PATCH
input schema is defined) as an optional object mirroring the type above. No other
route logic changes — the existing PATCH handler already writes whatever validated
fields it's given.

## Data flow

1. User clicks "Build Avatar" in `AgentIdentityCard` → `AvatarBuilderModal` opens.
2. Modal loads `agent.avatarParams` if present; otherwise starts from a fixed default
   (matching the prototype's initial state: tall head, shades, cybermohawk, goatee,
   default skin/hair, terracotta background).
3. Every control change updates local state and re-renders the SVG immediately
   (`useAvatarSvg(params)` — client-side only, no network round-trip per edit).
4. On Save:
   - Serialize the rendered SVG element to a string, wrap in a
     `Blob({ type: 'image/svg+xml' })`.
   - Reuse `ImageUpload.tsx`'s existing presigned-upload sequence verbatim:
     `POST /api/v1/files/upload` → `PUT` to S3 → `POST /api/v1/files/:id/confirm` →
     `GET /api/v1/files/:id/presigned-url`.
   - `PATCH` the agent with `{ avatarUrl: <returned url>, avatarParams: params }`.
5. `AgentIdentityCard` re-renders from `agent.avatarUrl` exactly as it does today for
   an uploaded image — no new rendering path, no persona-system involvement.

## Error handling & security

- The SVG is built entirely from closed enums and fixed hex palettes defined in
  `avatarParams.ts`. No free-text user input (e.g. agent name) is ever interpolated
  into SVG markup — the name stays a separate DB field rendered as a text badge
  outside the image, exactly as in the prototype. This closes off SVG-based
  markup/script injection: nothing user-typed ever reaches the image content.
- Upload failure (any step of the presigned flow) surfaces through the same
  error/retry UX `ImageUpload.tsx` already has — no new error handling path to build.
- If `avatarParams` is loaded with a missing or unrecognized key (e.g. a future enum
  value added after an agent was saved, or hand-edited data), `useAvatarSvg` falls
  back to that key's default rather than throwing, so the modal always renders
  something openable.

## Testing

- Unit tests on `useAvatarSvg`: every enum combination (or a representative sample
  across each param) produces well-formed SVG with the expected element structure
  (head, eyes, requested accessory, mouth, background all present).
- Component test on `AvatarBuilderModal`: opening with existing `avatarParams`
  restores those exact selections; changing a control updates the preview; Save
  triggers the upload sequence and the agent PATCH with the right payload (mocked
  network).
- Manual check in the running dev server: build an avatar end to end, confirm it
  persists across a reload, confirm it appears correctly in whatever other surfaces
  render `agent.avatarUrl` (agent list/cards, chat header, etc.) — per this repo's
  convention of testing UI changes in a live browser before calling them done.

## Open questions for the implementation plan

- Exact location of the agent-update zod schema to extend (`agents.crud.ts` vs. a
  shared validators file) — confirm during planning, not blocking for this spec.
- Whether `AvatarBuilderModal` should also be offered as a step inside
  `CreateAgentForm.tsx` at agent-creation time. Explicitly deferred: this design scopes
  the entry point to `AgentIdentityCard` only (post-creation, edit-anytime), per
  product decision to keep this an independent identity step rather than part of
  agent creation.
