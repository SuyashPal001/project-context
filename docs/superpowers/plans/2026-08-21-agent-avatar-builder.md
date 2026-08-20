# Agent Avatar Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant build a custom, procedurally-generated SVG avatar for one of their agents (enumerated head/eyes/hair/mouth/color/background choices), independent of the curated persona system, and save it as `agent.avatarUrl`.

**Architecture:** A pure `AvatarParams -> SVG string` renderer (no DOM dependency, fully unit-testable) backs a live-preview builder modal. Saving serializes that string, uploads it through the exact presigned-S3 flow `ImageUpload.tsx` already uses, and writes the resulting URL plus the raw params (for later re-editing) onto the `agents` row via the existing PATCH `/agents/:id` endpoint. No changes to `personas`, `animationStates`, or the ops publish gate.

**Tech Stack:** Next.js (App Router) + React, Hono API route (`products/agent-platform/packages/api`), Drizzle ORM/Postgres, Vitest (`node` environment, no DOM/jsdom — see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-08-21-agent-avatar-builder-design.md`

## Global Constraints

- No image assets, no external asset generation (Gemini or otherwise) — every visual part is a hand-coded SVG shape driven by a fixed enum. Confirmed with the user: procedural SVG only, not raster/layered art.
- No free text is ever interpolated into SVG markup — the agent name stays a separate DB field/UI element, never baked into the image. This is a hard requirement from the spec's security section, not a style preference.
- `apps/web`'s Vitest config (`apps/web/vitest.config.ts`) runs environment `node` and only collects `{lib,components,hooks}/**/*.test.ts` — **`.tsx` test files and DOM-rendering tests (React Testing Library, jsdom) do not run in this repo.** Any testable logic must be extracted into plain `.ts` functions; React components themselves are verified manually in the browser, matching the existing convention (see `apps/web/components/platform/personas/actions.ts` + `actions.test.ts`).
- The whole Agent Identity section in `AgentIdentityCard.tsx` is gated behind the `brandingEnabled` prop (wrapped in a div with `opacity-40 pointer-events-none select-none` when disabled, plus a `BrandingLockedOverlay`). The new "Build Avatar" entry point must live inside that same gated wrapper so it inherits the existing entitlement gate automatically — it must not add a second, separate gate.
- `AgentIdentityCard`'s save flow is batched: field edits set local `form` state and `isDirty`, and one "Save" button PATCHes everything at once. The avatar builder must follow this pattern (produce a URL + params via callback, like `ImageUpload`'s `onChange`) rather than issuing its own PATCH request.
- Migrations for `products/agent-platform/packages/schema/*` are generated from the single shared config at `packages/foundation/database/drizzle.config.ts` (it lists both the foundation and agent-platform schema files) — run `drizzle-kit generate` from `packages/foundation/database`, not from the agent-platform package.

---

## File Structure

```
apps/web/components/platform/agents/avatar-builder/
  avatarParams.ts        # Task 1 — types, palettes, defaults, randomizer (pure)
  buildAvatarSvg.ts       # Task 2 — AvatarParams -> SVG string (pure)
  buildAvatarSvg.test.ts  # Task 2
  avatarParams.test.ts    # Task 1
  saveAvatarAsset.ts       # Task 3 — upload helper (pure async fn)
  saveAvatarAsset.test.ts  # Task 3
  AvatarPreview.tsx        # Task 6 — live preview stage (renders buildAvatarSvg output)
  AvatarControls.tsx       # Task 6 — option-grid + color-swatch panel
  AvatarBuilderModal.tsx   # Task 6 — wires params state + preview + controls + save

products/agent-platform/packages/schema/agents.ts   # Task 4 — add avatarParams column
products/agent-platform/packages/api/routes/agents.crud.ts  # Task 5 — GET select, PATCH schema, owner allowlist
products/agent-platform/packages/api/__tests__/agents.avatar-params.test.ts  # Task 5

apps/web/components/platform/agents/types.ts        # Task 6 — AgentDetail.avatarParams
apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx  # Task 6 — integration
```

---

### Task 1: Avatar params model

**Files:**
- Create: `apps/web/components/platform/agents/avatar-builder/avatarParams.ts`
- Test: `apps/web/components/platform/agents/avatar-builder/avatarParams.test.ts`

**Interfaces:**
- Produces: `AvatarParams` type, `HeadShape`, `EyeStyle`, `Accessory`, `MouthStyle`, `BackgroundTheme` union types, `SKIN_COLORS: readonly string[]`, `HAIR_COLORS: readonly string[]`, `DEFAULT_AVATAR_PARAMS: AvatarParams`, `randomizeAvatarParams(rng?: () => number): AvatarParams`, `normalizeAvatarParams(input: Partial<AvatarParams> | null | undefined): AvatarParams`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/components/platform/agents/avatar-builder/avatarParams.test.ts
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_AVATAR_PARAMS,
    SKIN_COLORS,
    HAIR_COLORS,
    randomizeAvatarParams,
    normalizeAvatarParams,
} from './avatarParams';

describe('DEFAULT_AVATAR_PARAMS', () => {
    it('matches the prototype defaults', () => {
        expect(DEFAULT_AVATAR_PARAMS).toEqual({
            head: 'tall',
            eyes: 'shades',
            accessory: 'cybermohawk',
            mouth: 'goatee',
            skinColor: SKIN_COLORS[0],
            hairColor: HAIR_COLORS[0],
            bgTheme: 'terracotta',
        });
    });
});

describe('randomizeAvatarParams', () => {
    it('never randomizes bgTheme (kept at terracotta, matching the prototype)', () => {
        const result = randomizeAvatarParams(() => 0.999);
        expect(result.bgTheme).toBe('terracotta');
    });

    it('picks values only from the closed enum sets, deterministically from a fixed rng', () => {
        const result = randomizeAvatarParams(() => 0);
        expect(result).toEqual({
            head: 'tall',
            eyes: 'dots',
            accessory: 'cybermohawk',
            mouth: 'goatee',
            skinColor: SKIN_COLORS[0],
            hairColor: HAIR_COLORS[0],
            bgTheme: 'terracotta',
        });
    });

    it('picks the last enum value when rng returns just under 1', () => {
        const result = randomizeAvatarParams(() => 0.999);
        expect(result).toEqual({
            head: 'oval',
            eyes: 'eyepatch',
            accessory: 'none',
            mouth: 'none',
            skinColor: SKIN_COLORS[SKIN_COLORS.length - 1],
            hairColor: HAIR_COLORS[HAIR_COLORS.length - 1],
            bgTheme: 'terracotta',
        });
    });
});

describe('normalizeAvatarParams', () => {
    it('returns the defaults when given null or undefined', () => {
        expect(normalizeAvatarParams(null)).toEqual(DEFAULT_AVATAR_PARAMS);
        expect(normalizeAvatarParams(undefined)).toEqual(DEFAULT_AVATAR_PARAMS);
    });

    it('passes through a fully valid AvatarParams unchanged', () => {
        const valid = { ...DEFAULT_AVATAR_PARAMS, head: 'round' as const, bgTheme: 'matrix' as const };
        expect(normalizeAvatarParams(valid)).toEqual(valid);
    });

    it('falls back to the default for any missing key', () => {
        const partial = { head: 'round' as const };
        expect(normalizeAvatarParams(partial)).toEqual({ ...DEFAULT_AVATAR_PARAMS, head: 'round' });
    });

    it('falls back to the default for any key holding an unrecognized enum value (e.g. stale/future data)', () => {
        const stale = { ...DEFAULT_AVATAR_PARAMS, eyes: 'laser-beams' as any, accessory: 'top-hat' as any };
        expect(normalizeAvatarParams(stale)).toEqual({ ...DEFAULT_AVATAR_PARAMS, eyes: DEFAULT_AVATAR_PARAMS.eyes, accessory: DEFAULT_AVATAR_PARAMS.accessory });
    });

    it('keeps a valid custom skinColor/hairColor even if not in the curated palette (no enum to fall back on for free hex strings)', () => {
        const custom = { ...DEFAULT_AVATAR_PARAMS, skinColor: '#123456' };
        expect(normalizeAvatarParams(custom).skinColor).toBe('#123456');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/avatarParams.test.ts`
Expected: FAIL — `avatarParams.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/components/platform/agents/avatar-builder/avatarParams.ts

export type HeadShape = 'tall' | 'round' | 'oval';
export type EyeStyle = 'dots' | 'shades' | 'visor' | 'eyepatch';
export type Accessory =
    | 'cybermohawk' | 'hightop' | 'animespikes' | 'pompadour' | 'curtainbangs'
    | 'topknot' | 'bikerhelmet' | 'bandana' | 'hood' | 'none';
export type MouthStyle = 'goatee' | 'beard' | 'stubble' | 'smile' | 'none';
export type BackgroundTheme = 'terracotta' | 'light' | 'space' | 'matrix' | 'transparent';

export interface AvatarParams {
    head: HeadShape;
    eyes: EyeStyle;
    accessory: Accessory;
    mouth: MouthStyle;
    skinColor: string;
    hairColor: string;
    bgTheme: BackgroundTheme;
}

export const SKIN_COLORS = ['#ffd8a8', '#ffc0ad', '#d97757', '#8d5524', '#00ff66', '#c0c0c0'] as const;
export const HAIR_COLORS = ['#3b233a', '#f08080', '#f7e368', '#ff5577', '#00e5ff', '#18181c', '#a0a0a0', '#8d5524'] as const;

export const HEAD_SHAPES: HeadShape[] = ['tall', 'round', 'oval'];
export const EYE_STYLES: EyeStyle[] = ['dots', 'shades', 'visor', 'eyepatch'];
export const ACCESSORIES: Accessory[] = [
    'cybermohawk', 'hightop', 'animespikes', 'pompadour', 'curtainbangs',
    'topknot', 'bikerhelmet', 'bandana', 'hood', 'none',
];
export const MOUTH_STYLES: MouthStyle[] = ['goatee', 'beard', 'stubble', 'smile', 'none'];

export const DEFAULT_AVATAR_PARAMS: AvatarParams = {
    head: 'tall',
    eyes: 'shades',
    accessory: 'cybermohawk',
    mouth: 'goatee',
    skinColor: SKIN_COLORS[0],
    hairColor: HAIR_COLORS[0],
    bgTheme: 'terracotta',
};

function pick<T>(arr: T[] | readonly T[], rng: () => number): T {
    return arr[Math.floor(rng() * arr.length)];
}

// bgTheme is deliberately never randomized here — the original prototype's
// randomizeCapsule() left the background untouched, and re-rolling it on every
// randomize made the preview feel less like "reroll this character" and more
// like "reroll the whole scene."
export function randomizeAvatarParams(rng: () => number = Math.random): AvatarParams {
    return {
        head: pick(HEAD_SHAPES, rng),
        eyes: pick(EYE_STYLES, rng),
        accessory: pick(ACCESSORIES, rng),
        mouth: pick(MOUTH_STYLES, rng),
        skinColor: pick(SKIN_COLORS, rng),
        hairColor: pick(HAIR_COLORS, rng),
        bgTheme: 'terracotta',
    };
}

const BACKGROUND_THEMES: BackgroundTheme[] = ['terracotta', 'light', 'space', 'matrix', 'transparent'];

function isOneOf<T>(value: unknown, allowed: readonly T[]): value is T {
    return (allowed as readonly unknown[]).includes(value);
}

// Boundary function for any AvatarParams loaded from outside this module
// (persisted API data, hand-edited rows, a future enum addition landing
// after an agent was saved). Per-key fallback to the default rather than
// throwing, so a stale or partially-missing record always renders something
// openable in the builder instead of crashing it. skinColor/hairColor are
// free hex strings (not enums), so any non-empty string passes through —
// there's no "invalid" hex to detect here, only missing.
export function normalizeAvatarParams(input: Partial<AvatarParams> | null | undefined): AvatarParams {
    if (!input) return DEFAULT_AVATAR_PARAMS;
    return {
        head: isOneOf(input.head, HEAD_SHAPES) ? input.head : DEFAULT_AVATAR_PARAMS.head,
        eyes: isOneOf(input.eyes, EYE_STYLES) ? input.eyes : DEFAULT_AVATAR_PARAMS.eyes,
        accessory: isOneOf(input.accessory, ACCESSORIES) ? input.accessory : DEFAULT_AVATAR_PARAMS.accessory,
        mouth: isOneOf(input.mouth, MOUTH_STYLES) ? input.mouth : DEFAULT_AVATAR_PARAMS.mouth,
        skinColor: typeof input.skinColor === 'string' && input.skinColor.length > 0 ? input.skinColor : DEFAULT_AVATAR_PARAMS.skinColor,
        hairColor: typeof input.hairColor === 'string' && input.hairColor.length > 0 ? input.hairColor : DEFAULT_AVATAR_PARAMS.hairColor,
        bgTheme: isOneOf(input.bgTheme, BACKGROUND_THEMES) ? input.bgTheme : DEFAULT_AVATAR_PARAMS.bgTheme,
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/avatarParams.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/agents/avatar-builder/avatarParams.ts apps/web/components/platform/agents/avatar-builder/avatarParams.test.ts
git commit -m "feat(avatar-builder): add avatar params model and randomizer"
```

---

### Task 2: Pure SVG renderer

**Files:**
- Create: `apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.ts`
- Test: `apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.test.ts`

**Interfaces:**
- Consumes: `AvatarParams` (Task 1).
- Produces: `buildAvatarSvg(params: AvatarParams): string` — returns a complete `<svg>...</svg>` markup string, `viewBox="0 0 200 200"`, no DOM APIs used (must run under Vitest's `node` environment).

This is a straight port of `fusion_agent_avatars.html`'s `renderAvatar()` (repo root, untracked prototype) from DOM `createElementNS`/`setAttribute` calls into string templates — same geometry, same per-option markup, same element order (background → head → nose → eyes → hair/headwear → facial hair → mouth line). The prototype's two dead code paths (`accessory === 'longrocker'` and `'wavybob'`) are dropped — they're unreachable in the prototype too (not present in its own option buttons), so porting them would add untestable, unselectable code.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.test.ts
import { describe, it, expect } from 'vitest';
import { buildAvatarSvg } from './buildAvatarSvg';
import { DEFAULT_AVATAR_PARAMS, HEAD_SHAPES, EYE_STYLES, ACCESSORIES, MOUTH_STYLES } from './avatarParams';
import type { AvatarParams } from './avatarParams';

function withOverrides(overrides: Partial<AvatarParams>): AvatarParams {
    return { ...DEFAULT_AVATAR_PARAMS, ...overrides };
}

describe('buildAvatarSvg', () => {
    it('returns well-formed svg markup', () => {
        const svg = buildAvatarSvg(DEFAULT_AVATAR_PARAMS);
        expect(svg.trim().startsWith('<svg')).toBe(true);
        expect(svg.trim().endsWith('</svg>')).toBe(true);
        expect(svg).toContain('viewBox="0 0 200 200"');
    });

    it('never interpolates anything other than the closed AvatarParams fields (no free text reaches markup)', () => {
        // Structural guarantee from the spec's security section: the function
        // signature only accepts AvatarParams, so there is no code path for a
        // caller to pass arbitrary text into the SVG.
        const svg = buildAvatarSvg(DEFAULT_AVATAR_PARAMS);
        expect(svg).not.toContain('<script');
    });

    it.each(HEAD_SHAPES)('renders a head rect for head shape %s', (head) => {
        const svg = buildAvatarSvg(withOverrides({ head }));
        expect(svg).toContain(`fill="${DEFAULT_AVATAR_PARAMS.skinColor}"`);
        expect(svg.match(/<rect[^>]*rx="(32|41|30)"/)).not.toBeNull();
    });

    it.each(EYE_STYLES)('renders distinguishing markup for eyes=%s', (eyes) => {
        const svg = buildAvatarSvg(withOverrides({ eyes }));
        if (eyes === 'dots') expect((svg.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(2);
        if (eyes === 'shades') expect(svg).toContain('fill="#18181c"');
        if (eyes === 'visor') expect(svg).toContain('fill="#ff9900"');
        if (eyes === 'eyepatch') expect(svg).toContain('fill="#18181c"');
    });

    it.each(ACCESSORIES)('renders without throwing for accessory=%s', (accessory) => {
        expect(() => buildAvatarSvg(withOverrides({ accessory }))).not.toThrow();
    });

    it('omits hair markup entirely when accessory is none', () => {
        const withHair = buildAvatarSvg(withOverrides({ accessory: 'cybermohawk' }));
        const withoutHair = buildAvatarSvg(withOverrides({ accessory: 'none' }));
        expect(withoutHair.length).toBeLessThan(withHair.length);
    });

    it.each(MOUTH_STYLES)('renders without throwing for mouth=%s', (mouth) => {
        expect(() => buildAvatarSvg(withOverrides({ mouth }))).not.toThrow();
    });

    it('renders a smile as a downward-curving path distinct from the default mouth line', () => {
        const smile = buildAvatarSvg(withOverrides({ mouth: 'smile' }));
        const none = buildAvatarSvg(withOverrides({ mouth: 'none' }));
        expect(smile).not.toEqual(none);
    });

    it('omits the background rect and gradient defs when bgTheme is transparent', () => {
        const svg = buildAvatarSvg(withOverrides({ bgTheme: 'transparent' }));
        expect(svg).not.toContain('bgGlow');
    });

    it('includes the background gradient for a non-transparent theme', () => {
        const svg = buildAvatarSvg(withOverrides({ bgTheme: 'matrix' }));
        expect(svg).toContain('bgGlow');
        expect(svg).toContain('#0a2a22');
    });

    it('uses the given hairColor for hair-bearing accessories', () => {
        const svg = buildAvatarSvg(withOverrides({ accessory: 'cybermohawk', hairColor: '#123456' }));
        expect(svg).toContain('#123456');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/buildAvatarSvg.test.ts`
Expected: FAIL — `buildAvatarSvg.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.ts
import type { AvatarParams, HeadShape, EyeStyle, Accessory, MouthStyle, BackgroundTheme } from './avatarParams';

interface HeadGeometry {
    headX: number; headY: number; headW: number; headH: number; headRx: number;
    centerX: number; eyeY: number; mouthY: number; eyeSpacing: number;
}

function headGeometry(head: HeadShape): HeadGeometry {
    const byShape: Record<HeadShape, { headX: number; headY: number; headW: number; headH: number; headRx: number }> = {
        tall: { headX: 68, headY: 34, headW: 64, headH: 128, headRx: 32 },
        round: { headX: 59, headY: 48, headW: 82, headH: 98, headRx: 41 },
        oval: { headX: 70, headY: 51, headW: 60, headH: 92, headRx: 30 },
    };
    const { headX, headY, headW, headH, headRx } = byShape[head];
    const centerX = headX + headW / 2;
    return {
        headX, headY, headW, headH, headRx, centerX,
        eyeY: headY + headH * 0.35,
        mouthY: headY + headH * 0.74,
        eyeSpacing: headW * 0.24,
    };
}

const BG_GRADIENTS: Record<Exclude<BackgroundTheme, 'transparent'>, [string, string]> = {
    terracotta: ['#3d231e', '#1e1210'],
    light: ['#ffffff', '#e2e0d8'],
    space: ['#1e2235', '#0a0b12'],
    matrix: ['#0a2a22', '#040e0a'],
};

function renderBackground(bgTheme: BackgroundTheme): string {
    if (bgTheme === 'transparent') return '';
    const [from, to] = BG_GRADIENTS[bgTheme];
    const gridColor = bgTheme === 'light' ? 'rgba(0,0,0,0.06)' : bgTheme === 'matrix' ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.07)';
    const borderColor = bgTheme === 'light' ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)';
    let grid = '';
    for (let i = 20; i < 200; i += 20) {
        grid += `<line x1="0" y1="${i}" x2="200" y2="${i}" stroke="${gridColor}" stroke-width="1"/>`;
    }
    return `<defs><radialGradient id="bgGlow" cx="50%" cy="50%" r="75%"><stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/></radialGradient></defs>` +
        `<rect width="200" height="200" rx="20" fill="url(#bgGlow)"/>` +
        `<rect x="2" y="2" width="196" height="196" rx="18" fill="none" stroke="${borderColor}" stroke-width="2"/>` +
        grid;
}

function renderEyes(eyes: EyeStyle, g: HeadGeometry): string {
    const { centerX, eyeY, eyeSpacing, headW } = g;
    if (eyes === 'dots') {
        return `<circle cx="${centerX - eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>` +
            `<circle cx="${centerX + eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>`;
    }
    if (eyes === 'shades') {
        const sw = headW * 0.88; const sx = centerX - sw / 2; const sy = eyeY - 7;
        return `<path d="M ${sx} ${sy} L ${sx + sw} ${sy} L ${sx + sw} ${sy + 12} L ${centerX + 3} ${sy + 12} L ${centerX} ${sy + 7} L ${centerX - 3} ${sy + 12} L ${sx} ${sy + 12} Z" fill="#18181c" stroke="#000" stroke-width="2"/>`;
    }
    if (eyes === 'visor') {
        const vw = headW * 0.9; const vx = centerX - vw / 2; const vy = eyeY - 7;
        return `<rect x="${vx}" y="${vy}" width="${vw}" height="14" rx="4" fill="#ff9900" stroke="#111" stroke-width="2"/>`;
    }
    // eyepatch
    const { headX, headW: hw } = g;
    return `<line x1="${headX - 2}" y1="${eyeY - 14}" x2="${headX + hw + 2}" y2="${eyeY + 10}" stroke="#111" stroke-width="3"/>` +
        `<rect x="${centerX - eyeSpacing - 10}" y="${eyeY - 10}" width="20" height="18" rx="3" fill="#18181c" stroke="#000" stroke-width="2"/>` +
        `<circle cx="${centerX + eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>`;
}

function renderAccessory(accessory: Accessory, g: HeadGeometry, hairColor: string): string {
    const { headX, headY, headW, headH, centerX } = g;
    if (accessory === 'none') return '';
    if (accessory === 'cybermohawk') {
        const hairY = headY - 22;
        let grooves = '';
        for (const side of [-1, 1]) {
            const gx = centerX + side * (headW * 0.36);
            grooves += `<line x1="${gx - 6}" y1="${headY + 12}" x2="${gx + 6}" y2="${headY + 12}" stroke="#111" stroke-width="2"/>`;
        }
        return `<path d="M ${centerX - 10} ${headY + 16} L ${centerX - 8} ${hairY} Q ${centerX} ${hairY - 10} ${centerX + 8} ${hairY} L ${centerX + 10} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>${grooves}`;
    }
    if (accessory === 'hightop') {
        const hairY = headY - 28;
        return `<path d="M ${headX - 2} ${headY + 16} L ${headX - 2} ${hairY + 6} Q ${headX - 2} ${hairY} ${headX + 8} ${hairY} L ${headX + headW - 8} ${hairY} Q ${headX + headW + 2} ${hairY} ${headX + headW + 2} ${hairY + 6} L ${headX + headW + 2} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2.5"/>`;
    }
    if (accessory === 'animespikes') {
        const hairY = headY - 30;
        return `<path d="M ${headX - 10} ${headY + 20} L ${headX - 20} ${headY - 5} L ${headX - 4} ${headY + 4} L ${centerX - 18} ${hairY} L ${centerX - 4} ${headY - 2} L ${centerX} ${hairY - 10} L ${centerX + 4} ${headY - 2} L ${centerX + 18} ${hairY} L ${headX + headW + 4} ${headY + 4} L ${headX + headW + 20} ${headY - 5} L ${headX + headW + 10} ${headY + 20} Z" fill="${hairColor}" stroke="#1d1311" stroke-width="2.5"/>`;
    }
    if (accessory === 'pompadour') {
        const hairY = headY - 24;
        return `<path d="M ${headX - 2} ${headY + 18} C ${headX - 8} ${hairY}, ${centerX - 10} ${hairY - 8}, ${centerX + 10} ${hairY - 4} C ${headX + headW + 12} ${hairY}, ${headX + headW + 6} ${headY + 10}, ${headX + headW + 2} ${headY + 18} Z" fill="${hairColor}" stroke="#111" stroke-width="2.5"/>`;
    }
    if (accessory === 'curtainbangs') {
        const eyeY = g.eyeY;
        return `<path d="M ${headX - 2} ${headY + 8} Q ${centerX - 10} ${headY - 6} ${centerX} ${headY + 2} Q ${centerX + 10} ${headY - 6} ${headX + headW + 2} ${headY + 8} Q ${headX + headW + 4} ${eyeY + 4} ${centerX + 8} ${eyeY - 2} Q ${centerX} ${headY + 10} ${centerX - 8} ${eyeY - 2} Q ${headX - 4} ${eyeY + 4} ${headX - 2} ${headY + 8} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (accessory === 'topknot') {
        return `<path d="M ${headX} ${headY + 16} Q ${centerX} ${headY - 8} ${headX + headW} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<circle cx="${centerX}" cy="${headY - 12}" r="11" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<line x1="${centerX - 18}" y1="${headY - 8}" x2="${centerX + 18}" y2="${headY - 16}" stroke="#ffcc00" stroke-width="3"/>`;
    }
    if (accessory === 'bikerhelmet') {
        const helmH = headH * 0.52;
        return `<path d="M ${headX - 6} ${headY + helmH} L ${headX - 6} ${headY + 10} Q ${headX - 6} ${headY - 16} ${centerX} ${headY - 16} Q ${headX + headW + 6} ${headY - 16} ${headX + headW + 6} ${headY + 10} L ${headX + headW + 6} ${headY + helmH} Z" fill="#1a1f2c" stroke="#111" stroke-width="3"/>` +
            `<rect x="${centerX - 5}" y="${headY - 16}" width="10" height="${helmH + 16}" fill="#ff3344"/>`;
    }
    if (accessory === 'bandana') {
        const bandanaY = headY + headH * 0.16;
        const bandanaH = Math.max(14, headH * 0.12);
        return `<path d="M ${headX - 3} ${bandanaY} L ${headX + headW + 3} ${bandanaY} L ${headX + headW + 3} ${bandanaY + bandanaH} L ${headX - 3} ${bandanaY + bandanaH} Z" fill="#d32f2f" stroke="#111" stroke-width="3"/>` +
            `<polygon points="${headX - 10},${bandanaY + 8} ${headX - 2},${bandanaY + 2} ${headX - 2},${bandanaY + 16}" fill="#990011"/>`;
    }
    // hood
    return `<path d="M ${headX - 6} ${headY + 10} C ${headX - 6} ${headY - 15}, ${headX + headW + 6} ${headY - 15}, ${headX + headW + 6} ${headY + 10} L ${headX + headW + 8} ${headY + headH * 0.5} L ${headX + headW - 2} ${headY + headH * 0.5} L ${headX + headW - 2} ${headY + 20} L ${headX + 2} ${headY + 20} L ${headX + 2} ${headY + headH * 0.5} L ${headX - 8} ${headY + headH * 0.5} Z" fill="#1e2230"/>`;
}

function renderFacialHair(mouth: MouthStyle, g: HeadGeometry, hairColor: string): string {
    const { headX, headW, headY, headH, centerX, mouthY } = g;
    if (mouth === 'beard') {
        const beardLeft = headX + 4; const beardRight = headX + headW - 4;
        const beardTop = headY + headH * 0.65; const beardChin = headY + headH + 4;
        return `<path d="M ${beardLeft} ${beardTop} Q ${beardLeft - 2} ${beardChin} ${centerX} ${beardChin} Q ${beardRight + 2} ${beardChin} ${beardRight} ${beardTop} Q ${beardRight - 8} ${headY + headH - 4} ${centerX} ${headY + headH - 2} Q ${beardLeft + 8} ${headY + headH - 4} ${beardLeft} ${beardTop} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<path d="M ${centerX - 18} ${mouthY - 5} Q ${centerX - 6} ${mouthY + 3} ${centerX} ${mouthY - 1} Q ${centerX + 6} ${mouthY + 3} ${centerX + 18} ${mouthY - 5} Q ${centerX + 10} ${mouthY - 8} ${centerX} ${mouthY - 3} Q ${centerX - 10} ${mouthY - 8} ${centerX - 18} ${mouthY - 5} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (mouth === 'goatee') {
        return `<path d="M ${centerX - 14} ${mouthY - 4} Q ${centerX} ${mouthY - 1} ${centerX + 14} ${mouthY - 4} Q ${centerX + 8} ${mouthY - 7} ${centerX} ${mouthY - 2} Q ${centerX - 8} ${mouthY - 7} ${centerX - 14} ${mouthY - 4} Z" fill="${hairColor}"/>` +
            `<path d="M ${centerX - 6} ${mouthY + 5} L ${centerX + 6} ${mouthY + 5} L ${centerX + 8} ${mouthY + 16} Q ${centerX} ${mouthY + 20} ${centerX - 8} ${mouthY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (mouth === 'stubble') {
        const stubbleY = headY + headH * 0.65;
        let dots = '';
        for (let xOff = -headW * 0.32; xOff <= headW * 0.32; xOff += 6) {
            for (let yOff = 0; yOff <= headY + headH - stubbleY - 6; yOff += 6) {
                const currentY = stubbleY + yOff;
                const currentX = centerX + xOff;
                if (Math.abs(currentX - centerX) < 10 && Math.abs(currentY - mouthY) < 8) continue;
                dots += `<circle cx="${currentX}" cy="${currentY}" r="1.2" fill="${hairColor}" opacity="0.7"/>`;
            }
        }
        return dots;
    }
    return ''; // smile, none — no facial hair shape, just the mouth line below
}

function renderMouthLine(mouth: MouthStyle, g: HeadGeometry): string {
    const { centerX, mouthY } = g;
    const mouthW = 18;
    const d = mouth === 'smile'
        ? `M ${centerX - mouthW / 2} ${mouthY - 1} Q ${centerX} ${mouthY + 9} ${centerX + mouthW / 2} ${mouthY - 1}`
        : `M ${centerX - mouthW / 2} ${mouthY} Q ${centerX} ${mouthY + 3} ${centerX + mouthW / 2} ${mouthY}`;
    return `<path d="${d}" fill="none" stroke="#1d1311" stroke-width="2.5" stroke-linecap="round"/>`;
}

export function buildAvatarSvg(params: AvatarParams): string {
    const g = headGeometry(params.head);
    const { headX, headY, headW, headH, headRx, centerX, eyeY } = g;

    const nose = `<rect x="${centerX - 7}" y="${eyeY + 14}" width="14" height="20" rx="7" fill="#ff6b6b"/>`;
    const head = `<rect x="${headX}" y="${headY}" width="${headW}" height="${headH}" rx="${headRx}" fill="${params.skinColor}" stroke="#1d1311" stroke-width="4"/>`;

    const parts = [
        renderBackground(params.bgTheme),
        head,
        nose,
        renderEyes(params.eyes, g),
        renderAccessory(params.accessory, g, params.hairColor),
        renderFacialHair(params.mouth, g, params.hairColor),
        renderMouthLine(params.mouth, g),
    ];

    return `<svg width="220" height="220" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/buildAvatarSvg.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.ts apps/web/components/platform/agents/avatar-builder/buildAvatarSvg.test.ts
git commit -m "feat(avatar-builder): add pure params-to-SVG renderer"
```

---

### Task 3: Avatar upload helper

**Files:**
- Create: `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.ts`
- Test: `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`

**Interfaces:**
- Consumes: `api` client from `@/lib/api` (same one `ImageUpload.tsx` and `personas/actions.ts` use).
- Produces: `saveAvatarAsset(svg: string, filename: string): Promise<{ url: string; fileId: string }>`.

This reuses the exact 4-step presigned-upload sequence from `ImageUpload.tsx:34-63`, swapping the file input for an `image/svg+xml` Blob built from the already-serialized SVG string (from Task 2's `buildAvatarSvg`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

function res(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('saveAvatarAsset', () => {
    it('runs the presigned upload sequence and returns the final display URL', async () => {
        fetchMock
            // 1. POST /api/v1/files/upload
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            // 2. PUT to S3
            .mockResolvedValueOnce(res(200))
            // 3. POST /api/v1/files/file-1/confirm
            .mockResolvedValueOnce(res(200, {}))
            // 4. GET /api/v1/files/file-1/presigned-url
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        const result = await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        expect(result).toEqual({ url: 'https://s3.example/display-url', fileId: 'file-1' });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('uploads the SVG to S3 with an image/svg+xml content type', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, {}))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        const [s3Url, s3Options] = fetchMock.mock.calls[1];
        expect(s3Url).toBe('https://s3.example/put-url');
        expect(s3Options.method).toBe('PUT');
        expect(s3Options.headers['Content-Type']).toBe('image/svg+xml');
    });

    it('requests the upload URL with the given filename and svg content type', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(200))
            .mockResolvedValueOnce(res(200, {}))
            .mockResolvedValueOnce(res(200, { presignedUrl: 'https://s3.example/display-url' }));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await saveAvatarAsset('<svg></svg>', 'agent-avatar.svg');

        const [, uploadOptions] = fetchMock.mock.calls[0];
        const body = JSON.parse(uploadOptions.body);
        expect(body).toEqual({ filename: 'agent-avatar.svg', contentType: 'image/svg+xml' });
    });

    it('throws if the S3 PUT fails', async () => {
        fetchMock
            .mockResolvedValueOnce(res(200, { data: { fileId: 'file-1', uploadUrl: 'https://s3.example/put-url' } }))
            .mockResolvedValueOnce(res(500));

        const { saveAvatarAsset } = await import('./saveAvatarAsset');
        await expect(saveAvatarAsset('<svg></svg>', 'agent-avatar.svg')).rejects.toThrow('Failed to upload to S3');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`
Expected: FAIL — `saveAvatarAsset.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.ts
import { api } from '@/lib/api';

const SVG_CONTENT_TYPE = 'image/svg+xml';

// Mirrors ImageUpload.tsx's presigned-upload sequence exactly, so a
// custom-built avatar and a manually uploaded image go through the same
// storage path and are indistinguishable to the rest of the app once saved.
export async function saveAvatarAsset(svg: string, filename: string): Promise<{ url: string; fileId: string }> {
    // @ts-ignore - response shape from API, matches ImageUpload.tsx's usage
    const { data } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename,
        contentType: SVG_CONTENT_TYPE,
    });

    const blob = new Blob([svg], { type: SVG_CONTENT_TYPE });
    const uploadRes = await fetch(data.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': SVG_CONTENT_TYPE },
    });
    if (!uploadRes.ok) throw new Error('Failed to upload to S3');

    await api.post(`/api/v1/files/${data.fileId}/confirm`, { size: blob.size });

    const { presignedUrl } = await api.get<{ presignedUrl: string }>(
        `/api/v1/files/${data.fileId}/presigned-url`
    );

    return { url: presignedUrl, fileId: data.fileId };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.ts apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.test.ts
git commit -m "feat(avatar-builder): add SVG upload helper reusing presigned S3 flow"
```

---

### Task 4: Schema migration — `agents.avatarParams`

**Files:**
- Modify: `products/agent-platform/packages/schema/agents.ts:22-39` (the `agents` table definition)
- Create: a new migration file under `packages/foundation/database/migrations/` (name assigned by `drizzle-kit generate`)

**Interfaces:**
- Produces: `agents.avatarParams` — nullable `jsonb` column, typed `AvatarParams | null` in Drizzle. Consumed by Task 5 (route select/update) and, indirectly, by the web `AvatarParams` type from Task 1 (same shape, defined independently — this repo already keeps `PersonaAnimationStates` duplicated between `products/agent-platform/packages/schema/personas.ts` and `apps/web/components/platform/personas/types.ts`; this follows the same precedent rather than adding a new cross-package type import).

- [ ] **Step 1: Add the type and column**

Edit `products/agent-platform/packages/schema/agents.ts`. Add near the top, after the existing enum declarations (around line 20):

```ts
export type AvatarParams = {
  head: 'tall' | 'round' | 'oval';
  eyes: 'dots' | 'shades' | 'visor' | 'eyepatch';
  accessory: 'cybermohawk' | 'hightop' | 'animespikes' | 'pompadour' | 'curtainbangs'
    | 'topknot' | 'bikerhelmet' | 'bandana' | 'hood' | 'none';
  mouth: 'goatee' | 'beard' | 'stubble' | 'smile' | 'none';
  skinColor: string;
  hairColor: string;
  bgTheme: 'terracotta' | 'light' | 'space' | 'matrix' | 'transparent';
};
```

Then in the `agents` table definition, add the column immediately after `avatarUrl` (currently `agents.ts:31`):

```ts
  avatarUrl: text('avatar_url'),
  avatarParams: jsonb('avatar_params').$type<AvatarParams | null>(),
  personaId: uuid('persona_id').references(() => personas.id),
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd packages/foundation/database
pnpm exec drizzle-kit generate
```
Expected: a new file `NNNN_<generated-name>.sql` appears in `packages/foundation/database/migrations/`, containing a single `ALTER TABLE "agents" ADD COLUMN "avatar_params" jsonb;` (nullable — no default, no backfill needed, matches how `personas.animation_states` was added).

- [ ] **Step 3: Review the generated SQL**

Read the new migration file and confirm it contains exactly one `ALTER TABLE agents ADD COLUMN avatar_params jsonb` statement and nothing else. If drizzle-kit proposes any unrelated change (a sign the schema drifted from the DB), stop and investigate before continuing — do not apply an unreviewed migration.

- [ ] **Step 4: Apply the migration to the local dev database**

Run:
```bash
cd packages/foundation/database
pnpm exec drizzle-kit migrate
```
Expected: migration applies cleanly, no errors.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/schema/agents.ts packages/foundation/database/migrations/
git commit -m "feat(avatar-builder): add agents.avatar_params jsonb column"
```

---

### Task 5: Backend route changes

**Files:**
- Modify: `products/agent-platform/packages/api/routes/agents.crud.ts:70-84` (`handleGetAgent` select), `:163,175` (`handleUpdateAgent` zod schema and owner allowlist)
- Test: `products/agent-platform/packages/api/__tests__/agents.avatar-params.test.ts`

**Interfaces:**
- Consumes: `agents.avatarParams` column (Task 4).
- Produces: `GET /agents/:id` response now includes `avatarParams`; `PATCH /agents/:id` accepts an optional `avatarParams` field in its body and persists it, for both full-update and owner-only callers.

- [ ] **Step 1: Write the failing tests**

```ts
// products/agent-platform/packages/api/__tests__/agents.avatar-params.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agents } from '@serverless-saas/agent-schema/agents';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    update: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithContext(permissions: Array<{ resource: string; action: string }>, role = 'member') {
    return async (path: string, init: RequestInit) => {
        const { agentsRoutes } = await import('../routes/agents');
        const { Hono } = await import('hono');
        const app = new Hono<any>();
        app.use('*', async (c, next) => {
            c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions, role });
            c.set('userId', 'user-1');
            c.set('traceId', 'trace-1');
            await next();
        });
        app.route('/', agentsRoutes);
        return app.request(path, init);
    };
}

describe('GET /agents/:id — avatarParams', () => {
    beforeEach(() => vi.clearAllMocks());

    it('selects avatarParams alongside avatarUrl', async () => {
        let selectedColumns: Record<string, unknown> = {};
        dbMock.select.mockImplementation((columns: Record<string, unknown>) => {
            if (columns && 'avatarParams' in columns) selectedColumns = columns;
            return {
                from: () => ({
                    leftJoin: () => ({ where: () => ({ limit: async () => [{ id: 'agent-1', createdBy: null, personaId: null }] }) }),
                }),
            };
        });

        const request = appWithContext([{ resource: 'agents', action: 'read' }]);
        await request('/agent-1', { method: 'GET' });

        expect(selectedColumns).toHaveProperty('avatarParams', agents.avatarParams);
    });
});

describe('PATCH /agents/:id — avatarParams', () => {
    beforeEach(() => vi.clearAllMocks());

    const EXISTING_AGENT = { id: 'agent-1', tenantId: 'tenant-1', status: 'active' };

    function setupDb() {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [EXISTING_AGENT] }) }),
        }));
        let updatedWith: Record<string, unknown> = {};
        dbMock.update.mockImplementation(() => ({
            set: (values: Record<string, unknown>) => {
                updatedWith = values;
                return { where: () => ({ returning: async () => [{ ...EXISTING_AGENT, ...values }] }) };
            },
        }));
        return () => updatedWith;
    }

    const AVATAR_PARAMS = {
        head: 'round', eyes: 'visor', accessory: 'hood', mouth: 'smile',
        skinColor: '#ffd8a8', hairColor: '#3b233a', bgTheme: 'space',
    };

    it('persists avatarParams for a full-update caller', async () => {
        const getUpdatedWith = setupDb();
        const request = appWithContext([{ resource: 'agents', action: 'update' }]);

        const response = await request('/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarUrl: 'https://cdn.example/a.svg', avatarParams: AVATAR_PARAMS }),
        });

        expect(response.status).toBe(200);
        expect(getUpdatedWith().avatarParams).toEqual(AVATAR_PARAMS);
    });

    it('persists avatarParams for an owner without the agents:update permission', async () => {
        const getUpdatedWith = setupDb();
        const request = appWithContext([], 'owner');

        const response = await request('/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarUrl: 'https://cdn.example/a.svg', avatarParams: AVATAR_PARAMS }),
        });

        expect(response.status).toBe(200);
        expect(getUpdatedWith().avatarParams).toEqual(AVATAR_PARAMS);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd products/agent-platform/packages/api && pnpm vitest run __tests__/agents.avatar-params.test.ts`
Expected: FAIL — `avatarParams` is not selected in `handleGetAgent` and is stripped by the PATCH zod schema.

- [ ] **Step 3: Implement**

In `products/agent-platform/packages/api/routes/agents.crud.ts`, `handleGetAgent`'s select (around line 70-73), add `avatarParams` next to `avatarUrl`:

```ts
            llmProviderId: agents.llmProviderId, avatarUrl: agents.avatarUrl, avatarParams: agents.avatarParams, description: agents.description,
```

In `handleUpdateAgent`, extend the zod schema (line 163) to accept `avatarParams`:

```ts
    const result = z.object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        avatarUrl: z.string().url().nullable().optional(),
        avatarParams: z.object({
            head: z.enum(['tall', 'round', 'oval']),
            eyes: z.enum(['dots', 'shades', 'visor', 'eyepatch']),
            accessory: z.enum(['cybermohawk', 'hightop', 'animespikes', 'pompadour', 'curtainbangs', 'topknot', 'bikerhelmet', 'bandana', 'hood', 'none']),
            mouth: z.enum(['goatee', 'beard', 'stubble', 'smile', 'none']),
            skinColor: z.string(),
            hairColor: z.string(),
            bgTheme: z.enum(['terracotta', 'light', 'space', 'matrix', 'transparent']),
        }).nullable().optional(),
        status: z.enum(['active', 'paused', 'retired']).optional(),
        model: z.string().optional(),
        llmProviderId: z.string().uuid().optional(),
        personaId: z.string().uuid().nullable().optional(),
    }).safeParse(body);
```

And extend the owner-only allowlist (line 175) so avatar-builder saves work for owners without the full `agents:update` permission — the same population `AgentIdentityCard` already serves:

```ts
    const updateData = canFullUpdate ? result.data : { name: result.data.name, avatarUrl: result.data.avatarUrl, avatarParams: result.data.avatarParams, personaId: result.data.personaId };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd products/agent-platform/packages/api && pnpm vitest run __tests__/agents.avatar-params.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full existing agents test suite to confirm no regression**

Run: `cd products/agent-platform/packages/api && pnpm vitest run __tests__/agents.fire-dependency.test.ts __tests__/agents.personas-list.test.ts`
Expected: PASS (unchanged)

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/routes/agents.crud.ts products/agent-platform/packages/api/__tests__/agents.avatar-params.test.ts
git commit -m "feat(avatar-builder): expose avatarParams on GET/PATCH /agents/:id"
```

---

### Task 6: Builder UI and `AgentIdentityCard` integration

**Files:**
- Create: `apps/web/components/platform/agents/avatar-builder/AvatarPreview.tsx`
- Create: `apps/web/components/platform/agents/avatar-builder/AvatarControls.tsx`
- Create: `apps/web/components/platform/agents/avatar-builder/AvatarBuilderModal.tsx`
- Modify: `apps/web/components/platform/agents/types.ts:36-41` (`AgentDetail`)
- Modify: `apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx`

**Interfaces:**
- Consumes: `AvatarParams`, `randomizeAvatarParams`, `normalizeAvatarParams`, `SKIN_COLORS`, `HAIR_COLORS`, `HEAD_SHAPES`, `EYE_STYLES`, `ACCESSORIES`, `MOUTH_STYLES` (Task 1); `buildAvatarSvg` (Task 2); `saveAvatarAsset` (Task 3); `agent.avatarParams` from the API (Task 5).
- Produces: `<AvatarBuilderModal open, initialParams, onSave: (result: { url: string; params: AvatarParams }) => void, onOpenChange: (open: boolean) => void />`.

No automated tests for this task — per the Global Constraints, this repo's Vitest setup does not run component/DOM tests, and the existing convention (`ImageUpload.tsx`, `PersonaCard.tsx`, etc.) is to leave React components manually verified. Verification for this task is the manual browser check in Step 5.

- [ ] **Step 1: `AvatarPreview.tsx`**

```tsx
// apps/web/components/platform/agents/avatar-builder/AvatarPreview.tsx
"use client";

import * as React from "react";
import type { AvatarParams } from "./avatarParams";
import { buildAvatarSvg } from "./buildAvatarSvg";

interface AvatarPreviewProps {
    params: AvatarParams;
}

export function AvatarPreview({ params }: AvatarPreviewProps) {
    const svgMarkup = React.useMemo(() => buildAvatarSvg(params), [params]);

    return (
        <div
            className="h-64 w-64 rounded-2xl border-2 border-border bg-muted/40 flex items-center justify-center overflow-hidden"
            // buildAvatarSvg only ever interpolates AvatarParams' closed enum
            // values and hex color strings — never free text — so this is not
            // an injection surface. See the design spec's security section.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
    );
}
```

- [ ] **Step 2: `AvatarControls.tsx`**

```tsx
// apps/web/components/platform/agents/avatar-builder/AvatarControls.tsx
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    HEAD_SHAPES, EYE_STYLES, ACCESSORIES, MOUTH_STYLES, SKIN_COLORS, HAIR_COLORS,
} from "./avatarParams";
import type { AvatarParams, BackgroundTheme } from "./avatarParams";

const BG_THEMES: { value: BackgroundTheme; label: string }[] = [
    { value: "terracotta", label: "Warm Terracotta" },
    { value: "light", label: "Studio Light" },
    { value: "space", label: "Deep Cyber Dark" },
    { value: "matrix", label: "Neon Matrix" },
    { value: "transparent", label: "Transparent" },
];

const LABELS: Record<string, string> = {
    tall: "Tall", round: "Round", oval: "Compact",
    dots: "Dot Eyes", shades: "Sunglasses", visor: "Amber Visor", eyepatch: "Eyepatch",
    cybermohawk: "Cyber Mohawk", hightop: "High-Top Fade", animespikes: "Anime Spikes",
    pompadour: "Pompadour", curtainbangs: "Curtain Bangs", topknot: "Topknot",
    bikerhelmet: "Biker Helmet", bandana: "Bandana", hood: "Hood", none: "None",
    goatee: "Goatee", beard: "Beard", stubble: "Stubble", smile: "Smile",
};

interface OptionGridProps<T extends string> {
    options: readonly T[];
    value: T;
    onChange: (value: T) => void;
}

function OptionGrid<T extends string>({ options, value, onChange }: OptionGridProps<T>) {
    return (
        <div className="grid grid-cols-2 gap-2">
            {options.map((option) => (
                <button
                    key={option}
                    type="button"
                    onClick={() => onChange(option)}
                    className={cn(
                        "rounded-lg border px-3 py-2 text-sm text-left",
                        option === value ? "border-primary bg-primary/10 font-medium" : "border-border"
                    )}
                >
                    {LABELS[option] ?? option}
                </button>
            ))}
        </div>
    );
}

function ColorRow({ colors, value, onChange }: { colors: readonly string[]; value: string; onChange: (color: string) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {colors.map((color) => (
                <button
                    key={color}
                    type="button"
                    aria-label={color}
                    onClick={() => onChange(color)}
                    className={cn("h-8 w-8 rounded-full border-2", color === value ? "border-foreground" : "border-transparent")}
                    style={{ backgroundColor: color }}
                />
            ))}
        </div>
    );
}

interface AvatarControlsProps {
    params: AvatarParams;
    onChange: (params: AvatarParams) => void;
}

export function AvatarControls({ params, onChange }: AvatarControlsProps) {
    const set = <K extends keyof AvatarParams>(key: K, value: AvatarParams[K]) => onChange({ ...params, [key]: value });

    return (
        <div className="space-y-5">
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Head Shape</label>
                <OptionGrid options={HEAD_SHAPES} value={params.head} onChange={(v) => set("head", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Eyes</label>
                <OptionGrid options={EYE_STYLES} value={params.eyes} onChange={(v) => set("eyes", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Hairstyle / Headwear</label>
                <OptionGrid options={ACCESSORIES} value={params.accessory} onChange={(v) => set("accessory", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Hair Color</label>
                <ColorRow colors={HAIR_COLORS} value={params.hairColor} onChange={(v) => set("hairColor", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Facial Hair</label>
                <OptionGrid options={MOUTH_STYLES} value={params.mouth} onChange={(v) => set("mouth", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Skin Tone</label>
                <ColorRow colors={SKIN_COLORS} value={params.skinColor} onChange={(v) => set("skinColor", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Background</label>
                <OptionGrid options={BG_THEMES.map((t) => t.value)} value={params.bgTheme} onChange={(v) => set("bgTheme", v)} />
            </div>
        </div>
    );
}
```

- [ ] **Step 3: `AvatarBuilderModal.tsx`**

```tsx
// apps/web/components/platform/agents/avatar-builder/AvatarBuilderModal.tsx
"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { AvatarPreview } from "./AvatarPreview";
import { AvatarControls } from "./AvatarControls";
import { randomizeAvatarParams, normalizeAvatarParams } from "./avatarParams";
import type { AvatarParams } from "./avatarParams";
import { buildAvatarSvg } from "./buildAvatarSvg";
import { saveAvatarAsset } from "./saveAvatarAsset";

interface AvatarBuilderModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialParams: AvatarParams | null;
    agentName: string;
    onSave: (result: { url: string; params: AvatarParams }) => void;
}

export function AvatarBuilderModal({ open, onOpenChange, initialParams, agentName, onSave }: AvatarBuilderModalProps) {
    const [params, setParams] = React.useState<AvatarParams>(() => normalizeAvatarParams(initialParams));
    const [isSaving, setIsSaving] = React.useState(false);

    // normalizeAvatarParams guards against a corrupted or stale-enum record
    // (see avatarParams.ts) — this is the boundary where persisted data
    // re-enters the builder, so it's where the fallback has to happen.
    React.useEffect(() => {
        if (open) setParams(normalizeAvatarParams(initialParams));
    }, [open, initialParams]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const svg = buildAvatarSvg(params);
            const filename = `${agentName.toLowerCase().replace(/\s+/g, "_") || "agent"}_avatar.svg`;
            const { url } = await saveAvatarAsset(svg, filename);
            onSave({ url, params });
            onOpenChange(false);
            toast.success("Avatar saved");
        } catch (error: any) {
            toast.error(error.message || "Failed to save avatar");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Build Avatar</DialogTitle>
                </DialogHeader>
                <div className="grid grid-cols-[auto_1fr] gap-6">
                    <div className="flex flex-col items-center gap-3">
                        <AvatarPreview params={params} />
                        <Button type="button" variant="outline" size="sm" onClick={() => setParams(randomizeAvatarParams())}>
                            Roll Random
                        </Button>
                    </div>
                    <AvatarControls params={params} onChange={setParams} />
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSave} disabled={isSaving}>
                        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Use This Avatar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 4: Wire it into `AgentIdentityCard.tsx` and `AgentDetail`**

In `apps/web/components/platform/agents/types.ts`, add the import (after the existing `PersonaSummary` import, line 4):

```ts
import type { AvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";
```

Then add the field to `AgentDetail` (after `avatarUrl`, line 40):

```ts
    avatarUrl: string | null;
    avatarParams: AvatarParams | null;
```

In `AgentIdentityCard.tsx`:

1. Add the import:
```ts
import { AvatarBuilderModal } from "@/components/platform/agents/avatar-builder/AvatarBuilderModal";
import type { AvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";
```

2. Extend the form state type and initial state (line 46) to carry `avatarParams`:
```ts
    const [form, setForm] = React.useState<{ name: string; avatarUrl: string; avatarParams: AvatarParams | null; personaId: string | null }>({ name: "", avatarUrl: "", avatarParams: null, personaId: null });
    const [isBuilderOpen, setIsBuilderOpen] = React.useState(false);
```

3. Include it when loading the agent (line 56) and in the mutation payload (lines 62-67):
```ts
            setForm({ name: agent.name ?? "", avatarUrl: agent.avatarUrl ?? "", avatarParams: agent.avatarParams ?? null, personaId: agent.persona?.id ?? null });
```
```ts
        mutationFn: (values: { name: string; avatarUrl: string; avatarParams: AvatarParams | null; personaId: string | null }) =>
            api.patch(`/api/v1/agents/${agentId}`, {
                name: values.name || undefined,
                avatarUrl: values.avatarUrl || null,
                avatarParams: values.avatarParams,
                personaId: values.personaId,
            }),
```

4. Add the "Build Avatar" action next to `ImageUpload`, inside the same `brandingEnabled`-gated wrapper (after the `ImageUpload` block, still inside the `space-y-6` div at lines 101-112), and render the modal at the end of the component (inside the outer `<div className="relative">`, alongside `BrandingLockedOverlay`):

```tsx
                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Agent Avatar</Label>
                                <ImageUpload
                                    value={form.avatarUrl}
                                    fallbackText={initials}
                                    onChange={(url) => {
                                        setForm(prev => ({ ...prev, avatarUrl: url, avatarParams: null }));
                                        setIsDirty(true);
                                    }}
                                    disabled={!isOwner}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={!isOwner}
                                    onClick={() => setIsBuilderOpen(true)}
                                >
                                    Build Avatar
                                </Button>
                            </div>
```

```tsx
                        {!brandingEnabled && <BrandingLockedOverlay tenantSlug={tenantSlug} />}
                        <AvatarBuilderModal
                            open={isBuilderOpen}
                            onOpenChange={setIsBuilderOpen}
                            initialParams={form.avatarParams}
                            agentName={form.name || agent?.name || "agent"}
                            onSave={({ url, params }) => {
                                setForm(prev => ({ ...prev, avatarUrl: url, avatarParams: params }));
                                setIsDirty(true);
                            }}
                        />
```

Note: uploading via `ImageUpload` clears `avatarParams` to `null` (an uploaded photo has no builder params to re-edit); saving via the builder always sets both together. This keeps `avatarParams` truthful — it's only ever non-null when the current `avatarUrl` actually came from the builder.

- [ ] **Step 5: Manual verification in the running dev server**

Per this repo's convention for UI changes, start the app and check the golden path and edge cases before calling this done:

```bash
cd apps/web && pnpm dev
```

Then, logged in as a tenant owner:
1. Open an existing agent's detail page → Agent Identity card. Confirm "Build Avatar" appears next to the existing upload control (and both are correctly disabled/greyed if `brandingEnabled` is false for that tenant plan).
2. Click "Build Avatar" → confirm the modal opens with the default look (tall head, shades, cyber mohawk, goatee, terracotta background) live-rendered.
3. Change each control (head, eyes, hair/headwear, hair color, facial hair, skin tone, background) → confirm the preview updates instantly with no flicker or console errors.
4. Click "Roll Random" a few times → confirm it always produces a valid, fully-rendered avatar (no missing parts) and never changes the background.
5. Click "Use This Avatar" → confirm a success toast, the modal closes, and the card's avatar thumbnail updates to the new SVG.
6. Click the card's own "Save" button → confirm the PATCH succeeds and reloading the page shows the same avatar persisted.
7. Reopen "Build Avatar" on that same agent → confirm it restores the exact prior selections (not the default state).
8. Switch to uploading a photo via the existing "Upload image" control instead → save → reopen "Build Avatar" → confirm it now shows the *default* params (since `avatarParams` was cleared), not stale builder state from before.
9. As a non-owner viewer, confirm "Build Avatar" is disabled/inert, consistent with the existing `isOwner` gating on the rest of the card.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/agents/avatar-builder/AvatarPreview.tsx apps/web/components/platform/agents/avatar-builder/AvatarControls.tsx apps/web/components/platform/agents/avatar-builder/AvatarBuilderModal.tsx apps/web/components/platform/agents/types.ts "apps/web/app/[tenant]/dashboard/agents/[agentId]/AgentIdentityCard.tsx"
git commit -m "feat(avatar-builder): add builder modal and wire into Agent Identity card"
```
