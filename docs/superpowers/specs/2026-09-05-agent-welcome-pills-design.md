# Chat welcome-screen suggestion pills: per-persona / per-type, not one generic fallback

Date: 2026-09-05
Status: approved for planning

## Context

`WelcomeView.tsx` shows 4 clickable suggestion pills under "Hi {name}! I'm {agent}." on the new/empty-chat screen. Today these are three hardcoded arrays, selected by matching `agent.name` as a string:

- `PM_PROMPTS` — opens a structured wizard flow (`onSelectPill(pill: PillType)`), matched via `agent.name.toLowerCase().includes('pm')`.
- `DIRECTOR_PROMPTS` — image-generation pills, matched via `agent.name.toLowerCase() === 'director'`.
- `GENERAL_PROMPTS` — 4 generic pills ("Brainstorm ideas", "Draft something", "Research a topic", "Explain a concept"), used for **every other agent** — Producer, Analyst, Tech Lead, any custom agent — regardless of what that agent actually does.

The name-substring match is also an existing latent bug: any persona whose name happens to contain "pm" as a substring hits the PM branch unconditionally, ahead of any other check.

The user's ask: every agent's pills should reflect what it does, and this should work automatically for any newly created agent — no hand-editing `WelcomeView.tsx` per agent going forward.

## Decisions made during brainstorming (including an Opus design review)

- **Suggested prompts are generated and stored on `personas`, not `agents`.** `products/agent-platform/packages/schema/personas.ts` has no `tenantId` — personas are a global catalog shared across all tenants. Generating per-agent (once per hire) would mean one LLM call per hire, forever, for output that is byte-identical across every tenant that hires the same persona. It also creates a cold-start gap: hire persona → land in chat within seconds → suggested prompts haven't finished generating yet → user sees the generic fallback right at the moment they're most likely to judge the product. Generating once at **persona publish** time (ops-side, low volume, no tenant in the request path) avoids both problems.
- **Official curated personas get hand-authored pills, not LLM-generated ones.** There are only a handful of these (Product Manager, Analyst, Project Manager, Tech Lead, Architect, Director, Producer, etc. — the current roster). Hand-authoring is more reliable than an LLM call for a small, known, slow-changing set, and sidesteps all LLM-failure-mode complexity for the common case. The LLM path exists only for personas created by users (if/when that's a feature) or as a fallback if hand-authoring lags behind new official personas.
- **`agent.description` is not overwritten from `persona.tagline`.** `WelcomeView` already renders `agent.description` as the visible greeting subhead (the line under "Hi {name}! I'm {agent}."). Copying `persona.tagline` into `agent.description` at hire time would silently change that visible copy and would go stale the moment ops edits the persona's tagline later. Instead, anywhere `agent.description` is read for display purposes, resolve it as `agent.description ?? persona.tagline` at read time — the agent-level field stays a genuine per-agent override (settable later via `AgentIdentityCard.tsx`, whenever that gets an edit-description field), and the persona-level tagline is the fallback, always live.
- **Custom agents (no persona) are not left on `GENERAL_PROMPTS` by default.** `CreateAgentForm.tsx` already collects `type: 'ops' | 'support' | 'billing' | 'custom'`. A static `Record<AgentType, Pill[]>` — same shape as the existing `agentTypeIcon.ts` lookup — covers `ops`/`support`/`billing` with zero schema changes and zero LLM calls. Only an agent with `type: 'custom'` and no persona still falls through to `GENERAL_PROMPTS`. This is the smallest true dead-end left, and it's an acceptable one: a bare custom agent genuinely has no signal to derive pills from beyond a free-text name.
- **Fallback chain is: persona pills → agent-type pills → `GENERAL_PROMPTS`.** Implemented as a single resolver function, not three separate conditionals scattered through `WelcomeView`.
- **PM and Director branches are untouched.** PM's pills open a structured wizard (`onSelectPill`), a fundamentally different mechanism from the plain-text-insert pills (`onSend`) everything else uses — conflating them isn't worth it for this pass. Director's pills stay hardcoded too (they're few, stable, and already correct). The one change: **the PM match becomes persona-slug-based, not a name substring**, fixing the "any persona named anything containing 'pm' silently hijacks the PM branch" bug.
- **No async per-agent worker job.** Because generation happens once at publish time (a low-volume, ops-triggered event), it can run synchronously in the publish-handler request, or as a simple one-off script/admin action — not a queued job triggered by tenant-facing traffic. This removes the entire class of concerns Opus flagged for the original per-agent-hire design: no retry-storms from a bad JSON parse in an SQS handler, no race between concurrent description edits, no per-tenant cost/abuse surface, no tenant-scoping bug risk in a worker UPDATE.
- **Number of pills is not a hard contract of exactly 4.** The LLM (for the rare non-curated persona path, if/when it's used) is asked for up to 4, each validated independently; the renderer does `slice(0, 4)` and treats fewer than 2 valid pills as a failure (falls back to the next tier in the chain). Hand-authored seed data for official personas is written as exactly 4 by convention, but the type is `Pill[]`, not a fixed-length tuple.
- **Icons are a constrained enum, not free text**, resolved via a new lookup table mirroring `agentTypeIcon.ts`'s `Record<key, LucideIcon>` + fallback pattern (fallback icon: `Sparkles`). This applies both to hand-authored seed pills and to any future LLM-generated ones — the storage shape doesn't distinguish how a pill was produced.

## Data model

New column on `personas` (`products/agent-platform/packages/schema/personas.ts`):

```ts
suggestedPrompts: jsonb('suggested_prompts')
    .$type<Array<{ icon: string; label: string; promptText: string }> | null>()
```

- `null` = not yet authored/generated for this persona (falls through to the next tier).
- Each item: `icon` is one of a fixed string enum (see Icon mapping below), `label` is the pill's visible text (clamp to ~24 chars when authoring/validating — the pill row is `flex-wrap max-w-md`, longer labels wrap into a lumpy third row), `promptText` is the text inserted into the composer on click (via `onSend`, same as `DIRECTOR_PROMPTS`/`GENERAL_PROMPTS` today).

No new column on `agents`. `agent.description` stays as-is (already exists, currently unused in practice — this spec doesn't change how/whether it gets set, only how it's read for display, per the decision above).

## Icon mapping

New file `apps/web/components/platform/chat/pillIcon.ts` (or colocated in `WelcomeView.tsx` if small enough — implementer's call), mirroring `agentTypeIcon.ts`:

```ts
const PILL_ICONS: Record<string, LucideIcon> = {
    'file-text': FileText, 'map': Map, 'list-checks': ListChecks, 'search': Search,
    'lightbulb': Lightbulb, 'pen-line': PenLine, 'help-circle': HelpCircle,
    'image-plus': ImagePlus, 'palette': Palette, 'sparkles': Sparkles,
    'layout-template': LayoutTemplate, 'music': Music, 'bar-chart': BarChart3,
    'code': Code2, 'calendar': CalendarCheck2,
    // extend as needed when authoring new personas' pills
};
function getPillIcon(key: string): LucideIcon {
    return PILL_ICONS[key] ?? Sparkles;
}
```

The enum is extended by adding entries here whenever a new persona's hand-authored pills need an icon not yet covered — this is a small, low-frequency edit (same maintenance cost as `agentTypeIcon.ts` already has for new agent types).

## Resolver logic (`WelcomeView.tsx`)

Replace the current `isPm`/`isDirector`/else three-way branch with:

```ts
function resolvePills(agent: Agent | null): Pill[] {
    const slug = agent?.persona?.slug;
    if (slug === DIRECTOR_PERSONA_SLUG) return DIRECTOR_PROMPTS;  // unchanged, hardcoded
    if (slug === PM_PERSONA_SLUG) return PM_PROMPTS;              // unchanged, hardcoded, now slug-based not name-substring
    const personaPills = agent?.persona?.suggestedPrompts;
    if (personaPills && personaPills.length >= 2) return personaPills.slice(0, 4);
    const typePills = AGENT_TYPE_PROMPTS[agent?.type ?? 'custom'];
    if (typePills) return typePills;
    return GENERAL_PROMPTS;
}
```

`DIRECTOR_PERSONA_SLUG`/`PM_PERSONA_SLUG` are constants the implementer sets by looking up the actual `slug` values of these two personas in the `personas` table/seed data — not guessed. This is an implementation-time lookup, not a design decision.

`AgentIdentityCard`/whatever hook already fetches `agent.persona` needs `persona.slug` and `persona.suggestedPrompts` included in the API response shape the frontend receives (`PersonaSummary` type or wherever `agent.persona` is currently typed) — check what's already returned vs what needs adding to the agent-fetch route's select/serialization.

`AGENT_TYPE_PROMPTS` is a new static `Record<'ops' | 'support' | 'billing', Pill[]>` (custom is intentionally absent — falls through to `GENERAL_PROMPTS`), hand-authored, living alongside the other hardcoded arrays in `WelcomeView.tsx`.

## Authoring official personas' pills

One-time backfill, covering every official persona **except** Director and PM (those two keep their separate hardcoded arrays and never read `suggestedPrompts`): Analyst, Project Manager, Tech Lead, Architect, Producer, and any others in the current roster. For each, hand-write 4 `{icon, label, promptText}` entries reflecting what that persona actually does, and write them via a migration/seed script or a one-off admin update — not a UI, since this is a rare ops-side action. Exact mechanism (raw SQL seed, a script under `products/agent-platform/packages/schema`, or an admin-only route) is an implementation-time choice, not a design decision — whichever matches how other one-off persona-catalog edits are currently done in this codebase (check for precedent before inventing a new mechanism).

## Validation on write (wherever pills get written — seed script or future LLM path)

- `icon`: coerce to the known key set; unrecognized keys are replaced with `'sparkles'` at write time (not left as junk for the renderer to paper over — keeps the stored data auditable).
- `label`: clamp to ~24 chars, strip newlines.
- `promptText`: strip newlines/control characters. (This matters more if an LLM-generation path is ever added for user-authored personas — user-influenced text becoming a composer prefill is worth treating as untrusted input even though it's low-severity here.)
- Fewer than 2 valid items after validation → treat as `null` (falls through), not as a partial array.

## Out of scope for this pass

- An LLM-generation pipeline for user-authored/custom personas. The data model (`personas.suggested_prompts`) supports it later without migration, but no generation code ships now — official personas are hand-authored, and non-official personas (if that becomes a feature) simply have `suggestedPrompts: null` and fall through the chain like any other ungenerated persona.
- An "edit agent description" UI. `agent.description` continues to be settable only via the existing `handleUpdateAgent` API path (no frontend caller today) — out of scope here, tracked as a known gap, not solved by this spec.
- Async/worker-driven generation triggered by tenant actions (hire, create). Explicitly rejected per the Opus review — publish-time, ops-triggered generation removes the need for it entirely.
