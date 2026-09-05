# Chat Welcome-Screen Pills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat welcome screen's hardcoded `agent.name`-matching pill logic (which dumps every non-PM/Director agent into 4 generic pills) with persona-level suggested prompts plus a per-agent-type static fallback, so any current or future agent shows pills relevant to what it actually does.

**Architecture:** New `personas.suggested_prompts` jsonb column (nullable, hand-authored per official persona — no LLM generation in this pass). `WelcomeView.tsx`'s pill selection becomes a single pure `resolvePills()` function checked by persona slug (Director/PM, unchanged, hardcoded) → persona's own `suggestedPrompts` → a static per-`AgentType` table → the existing generic fallback. Two `conversations.ts` route selects gain `slug` + `suggestedPrompts` on the embedded persona object so the frontend actually receives the new data.

**Tech Stack:** Drizzle ORM (postgres, Supabase), Hono API routes, Next.js/React frontend, vitest for both frontend and backend tests, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-05-agent-welcome-pills-design.md`

## Global Constraints

- Personas have no `tenantId` — `suggestedPrompts` lives on `personas`, not `agents` (spec decision, do not add a column to `agents`).
- `PM_PROMPTS` and `DIRECTOR_PROMPTS` stay exactly as they are today (same arrays, same `onSelectPill`/`onSend` mechanisms) — only the *matching condition* changes, from `agent.name` substring/equality to `agent.persona.slug`.
- Real persona slugs in the dev database (queried directly, not guessed): `pm`, `director`, `architect`, `producer`, `analyst`, `tech-lead`, `disco`.
- No async worker job, no LLM call in this plan — all `suggestedPrompts` values are hand-authored SQL, written once.
- Icon values are a closed string enum resolved via a lookup table with a `Sparkles` fallback — never render a raw/unrecognized icon key.
- Every `Pill`-shaped array element is `{ icon: string; label: string; promptText: string }` for the `onSend` mechanism (matches `DIRECTOR_PROMPTS`/`GENERAL_PROMPTS`'s existing `{icon, label, text}` shape — see Task 4 for the exact field name reconciliation, since the existing arrays use `text` not `promptText`).

---

## Task 1: Add `suggested_prompts` column to `personas` and generate the migration

**Files:**
- Modify: `products/agent-platform/packages/schema/personas.ts`
- Migration output (generated, not hand-written): `packages/foundation/database/migrations/<NNNN>_<name>.sql`

**Interfaces:**
- Produces: `PersonaRow.suggestedPrompts: Array<{ icon: string; label: string; promptText: string }> | null` (Drizzle-inferred type, consumed by Task 2's route code).

- [ ] **Step 1: Add the column to the schema**

In `products/agent-platform/packages/schema/personas.ts`, add one field to the `personas` table definition, right after `skillTags`:

```ts
  skillTags: jsonb('skill_tags').$type<string[]>().notNull().default([]),
  // Hand-authored per official persona (no LLM generation) — see
  // docs/superpowers/specs/2026-09-05-agent-welcome-pills-design.md.
  // null = not yet authored; WelcomeView falls through to a per-type or
  // generic fallback in that case, so this column is safe to add before
  // every persona has a value.
  suggestedPrompts: jsonb('suggested_prompts').$type<Array<{ icon: string; label: string; promptText: string }> | null>(),
  exampleAssetUrl: text('example_asset_url'),
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd packages/foundation/database && pnpm exec drizzle-kit generate
```

Expected: a new file appears under `packages/foundation/database/migrations/`, e.g. `0078_<generated-name>.sql`, containing:
```sql
ALTER TABLE "personas" ADD COLUMN "suggested_prompts" jsonb;
```
(Exact generated name/number will differ — drizzle-kit picks it. Verify the SQL body matches this `ALTER TABLE ... ADD COLUMN` shape with no other unrelated changes; if drizzle-kit proposes anything else, stop and investigate before continuing — it likely picked up unrelated schema drift.)

- [ ] **Step 3: Apply the migration to the dev database**

Run:
```bash
cd packages/foundation/database && pnpm exec drizzle-kit migrate
```

Expected: command completes without error, and reports the new migration as applied.

- [ ] **Step 4: Verify the column exists**

Run:
```bash
DBURL=$(grep "^DATABASE_URL=" apps/api/.env | cut -d= -f2-); psql "$DBURL" -c "\d personas" | grep suggested_prompts
```

Expected output: a line showing `suggested_prompts | jsonb`.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/schema/personas.ts packages/foundation/database/migrations/
git commit -m "feat(schema): add personas.suggested_prompts jsonb column"
```

---

## Task 2: Return `slug` and `suggestedPrompts` on the conversation's embedded persona

**Files:**
- Modify: `products/agent-platform/packages/api/routes/conversations.ts:53-78` (the shared `conversationSelect` const, used by `GET /conversations/:id` and the `PATCH` handler)
- Modify: `products/agent-platform/packages/api/routes/conversations.ts:129-141` (the inline select inside `GET /conversations` list handler)
- Test: `products/agent-platform/packages/api/__tests__/conversations.persona.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `personas.slug`, `personas.suggestedPrompts` (Drizzle column refs from `@serverless-saas/agent-schema/personas`, already imported in this file as `personas`).
- Produces: `conversation.agent.persona` response shape gains two fields: `slug: string | null`, `suggestedPrompts: Array<{icon,label,promptText}> | null`. Task 3's `PersonaSummary` type and Task 5's `resolvePills()` both consume this exact shape.

- [ ] **Step 1: Write the failing test**

Add this test to the end of `products/agent-platform/packages/api/__tests__/conversations.persona.test.ts` (inside the existing `describe` block, as a new `it`, using the same `mockSelectChain` helper already defined in that file):

```ts
    it('includes persona slug and suggestedPrompts so the frontend can resolve welcome pills', async () => {
        const { db } = await import('@serverless-saas/database/client');
        mockSelectChain(db, [{
            id: 'conv-3',
            tenantId: 'tenant-1',
            agentId: 'agent-3',
            userId: 'user-1',
            title: null,
            status: 'active',
            needsHuman: false,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            agent: {
                id: 'agent-3',
                name: 'Producer',
                type: 'custom',
                persona: {
                    id: 'persona-3',
                    name: 'Producer',
                    tagline: 'I make music',
                    slug: 'producer',
                    suggestedPrompts: [{ icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' }],
                },
            },
        }]);

        const { conversationsRoutes } = await import('../routes/conversations');
        const app = appWithContext();
        app.route('/conversations', conversationsRoutes);

        const res = await app.request('/conversations/conv-3');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.agent.persona.slug).toBe('producer');
        expect(body.data.agent.persona.suggestedPrompts).toEqual([
            { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
        ]);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/conversations.persona.test.ts
```
Expected: FAIL — `body.data.agent.persona.slug` is `undefined` (the route doesn't select it yet), so `expect(...).toBe('producer')` fails.

- [ ] **Step 3: Update the shared `conversationSelect` const**

In `products/agent-platform/packages/api/routes/conversations.ts`, change lines 74-76 from:
```ts
        persona: {
            id: personas.id, name: personas.name, tagline: personas.tagline,
        } as any,
```
to:
```ts
        persona: {
            id: personas.id, name: personas.name, tagline: personas.tagline,
            slug: personas.slug, suggestedPrompts: personas.suggestedPrompts,
        } as any,
```

- [ ] **Step 4: Update the inline select in the list handler**

In the same file, change lines 138-140 from:
```ts
                    persona: {
                        id: personas.id, name: personas.name, tagline: personas.tagline,
                    } as any,
```
to:
```ts
                    persona: {
                        id: personas.id, name: personas.name, tagline: personas.tagline,
                        slug: personas.slug, suggestedPrompts: personas.suggestedPrompts,
                    } as any,
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd products/agent-platform/packages/api && pnpm vitest run __tests__/conversations.persona.test.ts
```
Expected: PASS, all tests in the file (including the two pre-existing null-collapsing tests — this change must not break those).

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/routes/conversations.ts products/agent-platform/packages/api/__tests__/conversations.persona.test.ts
git commit -m "feat(api): return persona slug and suggestedPrompts on conversation.agent"
```

---

## Task 3: Add `suggestedPrompts` to the frontend `PersonaSummary` type

**Files:**
- Modify: `apps/web/components/platform/personas/types.ts:1-13`

**Interfaces:**
- Consumes: nothing (pure type change).
- Produces: `PersonaSummary.suggestedPrompts: Array<{ icon: string; label: string; promptText: string }> | null`, consumed by Task 5's `resolvePills()` via `agent.persona.suggestedPrompts` (`Agent.persona: PersonaSummary | null` already exists in `apps/web/components/platform/agents/types.ts:29`).

- [ ] **Step 1: Add the field**

In `apps/web/components/platform/personas/types.ts`, change:
```ts
export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    skillTags: string[];
    isOfficial: boolean;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    exampleAssetUrl2: string | null;
    exampleCaption2: string | null;
    defaultModel: string | null;
}
```
to:
```ts
export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    skillTags: string[];
    isOfficial: boolean;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    exampleAssetUrl2: string | null;
    exampleCaption2: string | null;
    defaultModel: string | null;
    /** Hand-authored per persona (see personas.suggested_prompts). null when
     *  not yet authored for this persona — callers fall through to a
     *  per-agent-type or generic fallback in that case. */
    suggestedPrompts: Array<{ icon: string; label: string; promptText: string }> | null;
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -i "personas/types\|WelcomeView\|conversations"
```
Expected: no new errors referencing `PersonaSummary` (this is an additive required field on an interface used only as a response-shape contract, not constructed as an object literal anywhere in the frontend — so no call site needs updating; if this command shows an error at some construction site, read it and fix that call site before moving on).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/platform/personas/types.ts
git commit -m "feat(web): add suggestedPrompts to PersonaSummary type"
```

---

## Task 4: Add the pill-icon lookup table

**Files:**
- Create: `apps/web/components/platform/chat/pillIcon.ts`
- Test: `apps/web/components/platform/chat/pillIcon.test.ts`

**Interfaces:**
- Produces: `getPillIcon(key: string | null | undefined): LucideIcon`, consumed by Task 5 (`WelcomeView.tsx`) to render any pill — hand-authored or persona-sourced — by its stored `icon` string key.

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/platform/chat/pillIcon.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getPillIcon } from './pillIcon';
import { Sparkles, Music, FileText } from 'lucide-react';

describe('getPillIcon', () => {
    it('resolves a known icon key', () => {
        expect(getPillIcon('music')).toBe(Music);
    });

    it('resolves another known icon key', () => {
        expect(getPillIcon('file-text')).toBe(FileText);
    });

    it('falls back to Sparkles for an unrecognized key', () => {
        expect(getPillIcon('not-a-real-icon')).toBe(Sparkles);
    });

    it('falls back to Sparkles for null/undefined', () => {
        expect(getPillIcon(null)).toBe(Sparkles);
        expect(getPillIcon(undefined)).toBe(Sparkles);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd apps/web && pnpm vitest run components/platform/chat/pillIcon.test.ts
```
Expected: FAIL — `pillIcon.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `apps/web/components/platform/chat/pillIcon.ts`:
```ts
import {
    Sparkles,
    FileText,
    Map,
    ListChecks,
    Search,
    Lightbulb,
    PenLine,
    HelpCircle,
    ImagePlus,
    Palette,
    LayoutTemplate,
    Music,
    BarChart3,
    Code2,
    Building2,
    CalendarCheck2,
    ClipboardList,
    Settings,
    LifeBuoy,
    CreditCard,
    type LucideIcon,
} from "lucide-react";

// Closed set of icon keys a persona's or agent-type's hand-authored (or,
// later, generated) suggested prompts may use. Extend this map when a new
// persona's pills need an icon not yet covered here — same maintenance cost
// as agentTypeIcon.ts already has for new agent types. Never render a raw
// icon-name string directly; always resolve through here so an unrecognized
// or malformed stored key degrades to Sparkles instead of rendering nothing.
const PILL_ICONS: Record<string, LucideIcon> = {
    'file-text': FileText,
    'map': Map,
    'list-checks': ListChecks,
    'search': Search,
    'lightbulb': Lightbulb,
    'pen-line': PenLine,
    'help-circle': HelpCircle,
    'image-plus': ImagePlus,
    'palette': Palette,
    'sparkles': Sparkles,
    'layout-template': LayoutTemplate,
    'music': Music,
    'bar-chart': BarChart3,
    'code': Code2,
    'building': Building2,
    'calendar': CalendarCheck2,
    'clipboard-list': ClipboardList,
    'settings': Settings,
    'life-buoy': LifeBuoy,
    'credit-card': CreditCard,
};

export function getPillIcon(key: string | null | undefined): LucideIcon {
    return (key && PILL_ICONS[key]) || Sparkles;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/web && pnpm vitest run components/platform/chat/pillIcon.test.ts
```
Expected: PASS, all 4 assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/chat/pillIcon.ts apps/web/components/platform/chat/pillIcon.test.ts
git commit -m "feat(web): add icon-key lookup table for dynamic welcome pills"
```

---

## Task 5: Rewrite `WelcomeView.tsx`'s pill selection as a pure, testable `resolvePills()`

**Files:**
- Modify: `apps/web/components/platform/chat/WelcomeView.tsx` (entire file — see below for the full replacement)
- Test: `apps/web/components/platform/chat/resolvePills.test.ts`

**Interfaces:**
- Consumes: `getPillIcon` (Task 4), `Agent`/`AgentType` (`../agents/types`), `PersonaSummary` (`../personas/types`, Task 3), `PillType` (`./WizardView`).
- Produces: `export function resolvePills(agent: Agent | null): Pill[]` and `export interface Pill { icon: LucideIcon; label: string; onClick: (ctx: { onSelectPill: (pill: PillType) => void; onSend: (text: string) => void }) => void }` — exported from `WelcomeView.tsx` for the test file to import directly (same pattern as `folderDisplayName` exported from `FolderScopeChip.tsx` for its test).

This task changes the pill data model slightly from the spec's literal `{icon, label, promptText}` for every pill: `PM_PROMPTS` entries need to call `onSelectPill(pill)` instead of `onSend(text)`, so `resolvePills()` returns a uniform `Pill[]` where each pill carries an `onClick` closure rather than raw `text`/`pill` fields — this keeps the renderer (the JSX `.map`) identical regardless of which source produced the pills, while preserving PM's distinct wizard-opening behavior exactly as it works today.

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/platform/chat/resolvePills.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { resolvePills } from './WelcomeView';
import type { Agent } from '../agents/types';

function makeAgent(overrides: Partial<Agent>): Agent {
    return {
        id: 'a1', tenantId: 't1', name: 'Test Agent', type: 'custom', status: 'active',
        model: null, llmProviderId: null, isInternal: false, isDefault: false,
        description: null, persona: null, avatarUrl: null, createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('resolvePills', () => {
    it('returns the hardcoded PM wizard pills when persona.slug is "pm"', () => {
        const agent = makeAgent({ persona: { id: 'p1', slug: 'pm', name: 'PM', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: null } });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Write a PRD', 'Build a roadmap', 'Break into tasks', 'Research a topic']);
    });

    it('returns the hardcoded Director pills when persona.slug is "director", ignoring any suggestedPrompts', () => {
        const agent = makeAgent({ persona: { id: 'p2', slug: 'director', name: 'Director', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [{ icon: 'sparkles', label: 'Should be ignored', promptText: 'x' }] } });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Generate an image', 'Create a logo', 'Design a banner', 'Illustrate an idea']);
    });

    it('returns the persona\'s own suggestedPrompts when present and not PM/Director', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p3', slug: 'producer', name: 'Producer', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
                { icon: 'music', label: 'Remix a track', promptText: 'Remix this track: ' },
            ] },
        });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Make a beat', 'Remix a track']);
    });

    it('falls through to the per-type table when persona.suggestedPrompts has fewer than 2 items', () => {
        const agent = makeAgent({
            type: 'billing',
            persona: { id: 'p4', slug: 'some-new-persona', name: 'New', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [{ icon: 'sparkles', label: 'Only one', promptText: 'x' }] },
        });
        const pills = resolvePills(agent);
        expect(pills.length).toBeGreaterThanOrEqual(2);
        expect(pills.map(p => p.label)).not.toContain('Only one');
    });

    it('falls through to the per-type table for a bare custom-type agent with no persona but a known type', () => {
        const agent = makeAgent({ type: 'billing', persona: null });
        const pills = resolvePills(agent);
        expect(pills.length).toBeGreaterThan(0);
        expect(pills.map(p => p.label)).not.toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });

    it('falls all the way through to GENERAL_PROMPTS for a bare custom agent with no persona and type "custom"', () => {
        const agent = makeAgent({ type: 'custom', persona: null });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });

    it('slices persona suggestedPrompts to at most 4', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p5', slug: 'five-pills', name: 'Five', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'sparkles', label: 'One', promptText: 'a' },
                { icon: 'sparkles', label: 'Two', promptText: 'b' },
                { icon: 'sparkles', label: 'Three', promptText: 'c' },
                { icon: 'sparkles', label: 'Four', promptText: 'd' },
                { icon: 'sparkles', label: 'Five', promptText: 'e' },
            ] },
        });
        const pills = resolvePills(agent);
        expect(pills.length).toBe(4);
    });

    it('clicking a resolved pill from a plain-text source calls onSend with its promptText', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p6', slug: 'producer2', name: 'Producer', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
                { icon: 'music', label: 'Remix', promptText: 'Remix ' },
            ] },
        });
        const pills = resolvePills(agent);
        const onSend = vi.fn();
        const onSelectPill = vi.fn();
        pills[0].onClick({ onSend, onSelectPill });
        expect(onSend).toHaveBeenCalledWith('Make a lofi beat about ');
        expect(onSelectPill).not.toHaveBeenCalled();
    });

    it('clicking a PM pill calls onSelectPill, not onSend', () => {
        const agent = makeAgent({ persona: { id: 'p7', slug: 'pm', name: 'PM', tagline: '', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: null } });
        const pills = resolvePills(agent);
        const onSend = vi.fn();
        const onSelectPill = vi.fn();
        pills[0].onClick({ onSend, onSelectPill });
        expect(onSelectPill).toHaveBeenCalledWith('prd');
        expect(onSend).not.toHaveBeenCalled();
    });

    it('handles a null agent by returning GENERAL_PROMPTS', () => {
        const pills = resolvePills(null);
        expect(pills.map(p => p.label)).toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd apps/web && pnpm vitest run components/platform/chat/resolvePills.test.ts
```
Expected: FAIL — `resolvePills` is not exported from `./WelcomeView` yet.

- [ ] **Step 3: Replace the whole content of `WelcomeView.tsx`**

```tsx
"use client";

import { FileText, Map, ListChecks, Search, Lightbulb, PenLine, HelpCircle, ImagePlus, Palette, Sparkles, LayoutTemplate, Music, BarChart3, Code2, Building2, CalendarCheck2, ClipboardList, Settings, LifeBuoy, CreditCard, type LucideIcon } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Button } from "@/components/ui/button";
import type { PillType } from "./WizardView";
import type { Agent, AgentType } from "../agents/types";
import type { PersonaAnimationState } from "../personas/usePersonaAnimationState";
import { getPillIcon } from "./pillIcon";

// The real slugs of the two personas with bespoke pill behavior, looked up
// directly against the dev database rather than guessed — see
// docs/superpowers/specs/2026-09-05-agent-welcome-pills-design.md.
const DIRECTOR_PERSONA_SLUG = 'director';
const PM_PERSONA_SLUG = 'pm';

export interface PillClickContext {
    onSelectPill: (pill: PillType) => void;
    onSend: (text: string) => void;
}

export interface Pill {
    icon: LucideIcon;
    label: string;
    onClick: (ctx: PillClickContext) => void;
}

function textPill(icon: LucideIcon, label: string, text: string): Pill {
    return { icon, label, onClick: ({ onSend }) => onSend(text) };
}

function wizardPill(icon: LucideIcon, label: string, pill: PillType): Pill {
    return { icon, label, onClick: ({ onSelectPill }) => onSelectPill(pill) };
}

// PM's pills open a structured wizard flow, a fundamentally different
// mechanism from every other agent's plain-text-insert pills — kept
// hardcoded and untouched by the persona/type resolution below.
const PM_PROMPTS: Pill[] = [
    wizardPill(FileText, "Write a PRD", "prd"),
    wizardPill(Map, "Build a roadmap", "roadmap"),
    wizardPill(ListChecks, "Break into tasks", "tasks"),
    wizardPill(Search, "Research a topic", "research"),
];

const DIRECTOR_PROMPTS: Pill[] = [
    textPill(ImagePlus, "Generate an image", "Generate an image of "),
    textPill(Palette, "Create a logo", "Design a logo for "),
    textPill(LayoutTemplate, "Design a banner", "Create a banner for "),
    textPill(Sparkles, "Illustrate an idea", "Create an illustration of "),
];

const GENERAL_PROMPTS: Pill[] = [
    textPill(Lightbulb, "Brainstorm ideas", "Help me brainstorm ideas for "),
    textPill(PenLine, "Draft something", "Help me draft "),
    textPill(Search, "Research a topic", "Research and summarise "),
    textPill(HelpCircle, "Explain a concept", "Explain "),
];

// Covers a bare agent (no persona attached) whose *type* still carries
// signal — e.g. a custom-created "Analyst"-type agent with no persona hire.
// 'custom' is intentionally absent: a truly bare custom agent has no signal
// beyond a free-text name, and falls through to GENERAL_PROMPTS below.
const AGENT_TYPE_PROMPTS: Partial<Record<AgentType, Pill[]>> = {
    product_manager: [
        textPill(FileText, "Write a PRD", "Help me write a PRD for "),
        textPill(Map, "Build a roadmap", "Help me build a roadmap for "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
    ],
    analyst: [
        textPill(BarChart3, "Analyze data", "Analyze this data: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(FileText, "Summarize a report", "Summarize this report: "),
        textPill(Lightbulb, "Find insights", "Find insights in "),
    ],
    project_manager: [
        textPill(CalendarCheck2, "Plan a sprint", "Help me plan a sprint for "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(ClipboardList, "Track status", "Summarize the status of "),
        textPill(Search, "Research a topic", "Research and summarise "),
    ],
    tech_lead: [
        textPill(Code2, "Review a design", "Review this technical design: "),
        textPill(ListChecks, "Break into tasks", "Break this into engineering tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    architect: [
        textPill(Building2, "Design a system", "Help me design a system for "),
        textPill(Code2, "Review a design", "Review this technical design: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    ops: [
        textPill(Settings, "Automate a task", "Help me automate "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    support: [
        textPill(LifeBuoy, "Draft a reply", "Help me draft a reply about "),
        textPill(PenLine, "Draft something", "Help me draft "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    billing: [
        textPill(CreditCard, "Explain a charge", "Explain this charge: "),
        textPill(FileText, "Draft something", "Help me draft "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
};

// The single source of truth for which 4 pills a given agent shows on its
// welcome screen. Exported (not just used internally) so resolvePills.test.ts
// can exercise every branch directly without mounting the component.
export function resolvePills(agent: Agent | null): Pill[] {
    const slug = agent?.persona?.slug;
    if (slug === DIRECTOR_PERSONA_SLUG) return DIRECTOR_PROMPTS;
    if (slug === PM_PERSONA_SLUG) return PM_PROMPTS;

    const personaPrompts = agent?.persona?.suggestedPrompts;
    if (personaPrompts && personaPrompts.length >= 2) {
        return personaPrompts.slice(0, 4).map(p => textPill(getPillIcon(p.icon), p.label, p.promptText));
    }

    const typePills = agent?.type ? AGENT_TYPE_PROMPTS[agent.type] : undefined;
    if (typePills) return typePills;

    return GENERAL_PROMPTS;
}

interface WelcomeViewProps {
    agent: Agent | null;
    firstName: string;
    onSelectPill: (pill: PillType) => void;
    onSend: (text: string) => void;
    children: React.ReactNode;
    /** Live chat-stream state — 'waving' for this greet screen (page.tsx
     * computes it that way for a new/empty conversation). Same opt-in
     * mechanism as MessageItem's avatar: no motion unless explicitly passed. */
    avatarLiveState?: PersonaAnimationState;
}

export function WelcomeView({ agent, firstName, onSelectPill, onSend, children, avatarLiveState }: WelcomeViewProps) {
    const agentName = agent?.name ?? 'your assistant';
    const isPm = agent?.persona?.slug === PM_PERSONA_SLUG;
    const isDirector = agent?.persona?.slug === DIRECTOR_PERSONA_SLUG;
    const tagline = agent?.description
        ?? agent?.persona?.tagline
        ?? (isPm ? 'I can help you plan, design, and ship.'
            : isDirector ? 'I generate and edit images from a description.'
            : 'How can I help you today?');

    const pills = resolvePills(agent);

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
                <div className="mb-6">
                    <AgentOrb size={96} state="idle" avatarUrl={agent?.avatarUrl} persona={agent?.persona} liveState={avatarLiveState} />
                </div>

                <h2 className="text-2xl font-bold tracking-tight mb-1">
                    Hi {firstName}! I&apos;m {agentName}.
                </h2>
                <p className="text-muted-foreground text-sm mb-8">{tagline}</p>

                <div className="flex flex-wrap gap-3 justify-center max-w-md">
                    {pills.map(({ icon: Icon, label, onClick }) => (
                        <Button key={label} variant="outline"
                            className="gap-2 rounded-full px-5 py-2 h-auto text-sm font-medium bg-secondary/50 border-border/60 hover:bg-secondary hover:border-border transition-colors"
                            onClick={() => onClick({ onSelectPill, onSend })}
                        >
                            <Icon className="h-4 w-4 text-muted-foreground" /> {label}
                        </Button>
                    ))}
                </div>
            </div>

            <div className="shrink-0 pt-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                {children}
            </div>
        </div>
    );
}
```

Note the tagline logic also now falls back to `agent?.persona?.tagline` before the PM/Director hardcoded strings — this is the spec's `description ?? persona.tagline` read-time resolution decision, applied here since this is the one place `agent.description` was already being read for display.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/web && pnpm vitest run components/platform/chat/resolvePills.test.ts
```
Expected: PASS, all 10 test cases.

- [ ] **Step 5: Type-check the whole web app**

Run:
```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -i "WelcomeView\|resolvePills"
```
Expected: no output (no errors referencing these files).

- [ ] **Step 6: Lint**

Run:
```bash
cd apps/web && pnpm exec eslint components/platform/chat/WelcomeView.tsx components/platform/chat/resolvePills.test.ts
```
Expected: no new errors (pre-existing unrelated warnings elsewhere in the repo are not this task's concern).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/WelcomeView.tsx apps/web/components/platform/chat/resolvePills.test.ts
git commit -m "feat(web): resolve welcome-screen pills by persona/type instead of agent.name matching"
```

---

## Task 6: Hand-author `suggested_prompts` for the 5 non-PM/Director official personas

**Files:**
- No source files — this is a direct data write against the dev database (matches how other one-off persona-catalog edits are done today: there is no seed-file mechanism in this repo for personas, per Task 1's investigation — `products/agent-platform/packages/schema` has no seeds directory, and `products/agent-platform/packages/api/routes/personas.ts` is the only persona-write surface, used interactively via its CRUD endpoints, not via a seed script).

**Interfaces:**
- Consumes: `personas.suggested_prompts` column (Task 1), icon keys from Task 4's `PILL_ICONS` map (`music`, `bar-chart`, `code`, `building`, `calendar`, `list-checks`, `search`, `lightbulb`, `file-text`, `sparkles`, `clipboard-list`, `image-plus`, `palette`, `layout-template`, `help-circle`, `pen-line`, `settings`, `life-buoy`, `credit-card`, `map`).
- Produces: real data behind Task 5's `resolvePills()` persona-pills branch — verified by Step 3 below via a real API call, not just a DB read.

- [ ] **Step 1: Write and run the SQL update**

Run this against the dev database (the five personas confirmed via direct query in Task 1 planning: `architect`, `producer`, `analyst`, `tech-lead`, `disco` — `pm` and `director` are deliberately excluded, they never read this column):

```bash
DBURL=$(grep "^DATABASE_URL=" apps/api/.env | cut -d= -f2-)
psql "$DBURL" <<'SQL'
UPDATE personas SET suggested_prompts = '[
  {"icon": "code", "label": "Review a design", "promptText": "Review this technical design: "},
  {"icon": "list-checks", "label": "Break into tasks", "promptText": "Break this into engineering tasks: "},
  {"icon": "building", "label": "Design a system", "promptText": "Help me design a system for "},
  {"icon": "help-circle", "label": "Explain a concept", "promptText": "Explain "}
]'::jsonb WHERE slug = 'architect';

UPDATE personas SET suggested_prompts = '[
  {"icon": "music", "label": "Make a beat", "promptText": "Make a lofi beat about "},
  {"icon": "music", "label": "Write a song", "promptText": "Write a song about "},
  {"icon": "music", "label": "Remix a track", "promptText": "Remix this track: "},
  {"icon": "sparkles", "label": "Get production tips", "promptText": "Give me production tips for "}
]'::jsonb WHERE slug = 'producer';

UPDATE personas SET suggested_prompts = '[
  {"icon": "bar-chart", "label": "Analyze data", "promptText": "Analyze this data: "},
  {"icon": "file-text", "label": "Summarize a report", "promptText": "Summarize this report: "},
  {"icon": "search", "label": "Research a topic", "promptText": "Research and summarise "},
  {"icon": "lightbulb", "label": "Find insights", "promptText": "Find insights in "}
]'::jsonb WHERE slug = 'analyst';

UPDATE personas SET suggested_prompts = '[
  {"icon": "code", "label": "Review a design", "promptText": "Review this technical design: "},
  {"icon": "list-checks", "label": "Break into tasks", "promptText": "Break this into engineering tasks: "},
  {"icon": "search", "label": "Research a topic", "promptText": "Research and summarise "},
  {"icon": "help-circle", "label": "Explain a concept", "promptText": "Explain "}
]'::jsonb WHERE slug = 'tech-lead';

UPDATE personas SET suggested_prompts = '[
  {"icon": "music", "label": "Make a beat", "promptText": "Make a beat for "},
  {"icon": "sparkles", "label": "Get a mix tip", "promptText": "Give me a mixing tip for "},
  {"icon": "search", "label": "Research a topic", "promptText": "Research and summarise "},
  {"icon": "help-circle", "label": "Explain a concept", "promptText": "Explain "}
]'::jsonb WHERE slug = 'disco';
SQL
```

Expected: 5 `UPDATE 1` lines (one per statement), no errors.

- [ ] **Step 2: Verify the writes**

Run:
```bash
DBURL=$(grep "^DATABASE_URL=" apps/api/.env | cut -d= -f2-)
psql "$DBURL" -c "select slug, jsonb_array_length(suggested_prompts) as n from personas where slug in ('architect','producer','analyst','tech-lead','disco');"
```
Expected: all 5 rows show `n = 4`.

- [ ] **Step 3: Verify end-to-end through the API (requires local API running per `apps/api` dev instructions)**

If a local API dev server is available (`cd apps/api && pnpm dev`), hit the conversations endpoint for a conversation whose agent has the `producer` persona and confirm the response's `data.agent.persona.suggestedPrompts` array matches what Step 1 wrote. If no local dev server is running in this environment, skip this step and note it as pending manual verification once deployed — do not skip Steps 1-2.

- [ ] **Step 4: Commit**

No source files changed in this task — nothing to commit. If this plan is executed with a companion data-migration script convention this repo doesn't currently have, that would be a separate follow-up, not part of this task.

---

## Final verification

- [ ] Run the full frontend test suite for the touched area: `cd apps/web && pnpm vitest run components/platform/chat/`
- [ ] Run the full backend test suite for the touched area: `cd products/agent-platform/packages/api && pnpm vitest run __tests__/conversations`
- [ ] Manually load the chat page for an agent hired from each of `producer`, `analyst`, `architect`, `tech-lead`, `disco`, `pm`, `director`, and a bare custom agent with no persona — confirm each shows pills matching this plan's data (persona pills for the first five, unchanged wizard/image pills for `pm`/`director`, `GENERAL_PROMPTS` for the bare custom agent).
