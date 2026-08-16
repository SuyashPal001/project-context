# Agent Personas — Design Spec

## Problem

Agents in the platform (Disco, Saarthi PM, Architect, and any tenant-created custom
agent) currently show a generic `Bot` icon everywhere in the UI, and each agent's
"personality" only exists implicitly in whatever prompt was hand-written for it. There's
no reusable, ownable character behind an agent — no visual identity, no consistent voice,
and no way to spin up a new agent instance that already comes with a defined personality
and skill set.

Inspiration: Omniwork's "team of experts" model — a roster of named personas (e.g.
`Film-Production-Director`, `Trend-To-Post`), each with an illustrated avatar, a tagline,
a skills list, and a detail card with "Fire" / "Assign Task Now" actions. We're building
our own version, animated (Petdex-style state animation) rather than static, and — unlike
both references — the animation and personality are tied to the agent's *real* runtime
state and *real* tool bindings, not decorative.

## Non-goals (this round)

- Open tenant-authored persona submissions (marketplace). Personas are authored by the
  project-context team only; the schema leaves room for an `isOfficial` flag so a
  non-official tier can be added later without migration.
- Reusing any art/character from Petdex or any other third-party gallery. Confirmed via
  Petdex's own docs that pet art is user-submitted fan art with per-submitter licensing
  and an active takedown process — not safe to reuse in a commercial product. All persona
  art is generated fresh (via Higgsfield), prompted from role/personality traits, never
  from existing named characters.
- Full video/streaming animation. "Animation" here means a small state machine (idle /
  thinking / responding), each state a short looping asset — not a video pipeline.

## Data model

New table `personas` in `products/agent-platform/packages/schema/personas.ts`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `slug` | text, unique | e.g. `architect`, `trend-to-post` |
| `name` | text | display name |
| `tagline` | text | one-line role description |
| `basePersonality` | text | reusable system-prompt fragment: tone, voice, values |
| `skillTags` | jsonb (string[]) | mirrors the agent's actual MCP tool/skill bindings |
| `animationStates` | jsonb | `{ idle: url, thinking: url, responding: url }` |
| `exampleAssetUrl` | text, nullable | sample output shown in the detail modal |
| `exampleCaption` | text, nullable | caption for the sample output |
| `isOfficial` | boolean, default true | all rows true for now; reserved for future tiers |
| `status` | enum `draft \| published` | drafts aren't selectable when creating an agent |
| `createdBy` | text | ops/admin identity, for audit |

`agents` table gains `personaId` (uuid, nullable FK → `personas.id`). Nullable because
custom agents can still exist without a persona (fall back to initials avatar, as today).

Authoring `personas` rows is an internal/ops-only route (same trust tier as other
internal-only tables) — no tenant-facing create/edit UI in this round.

## How it works (end to end)

1. **Authoring.** Your team defines a persona: name, tagline, base personality text,
   skill tags, and three animation assets (idle/thinking/responding), generated via
   Higgsfield from a written prompt spec per persona (role + personality traits — never
   "like character X"). Inserted via the internal ops route, `status: published`.

2. **Hiring / assigning.** A tenant browses the roster (the "Experts Market"-style detail
   modal — avatar, Official badge, description, skill tags, example asset, Fire / Assign
   Task Now). "Assign Task Now" creates a new row in `agents` with `personaId` set to that
   persona and opens a chat with it. "Fire" deactivates the tenant's existing agent
   instance bound to that persona (soft-delete / status change on the `agents` row, not a
   `personas` deletion — the persona itself stays in the library for others).

3. **Runtime prompt composition** (`apps/agent-orchestrator`). When an agent with a
   `personaId` runs, the final system prompt sent to the model is
   `persona.basePersonality` followed by the agent/task-specific instructions that exist
   today (`platformAgent`, `pmAgent`, etc. keep their current prompt logic — it's appended
   after the persona layer, not replaced). This is what makes personas reusable: the
   personality text is composed at request time from one row, never copy-pasted per agent
   instance.

4. **Runtime animation state.** The orchestrator already emits activity signal over
   SSE/WebSocket while streaming a response (thinking / tool-calling / streaming tokens).
   The web client maps that same stream to one of the persona's three animation states and
   swaps the rendered asset accordingly — no new backend event type, just a mapping layer
   in the client from existing stream events to `idle | thinking | responding`.

5. **Rendering.** Four existing UI surfaces swap their hardcoded `Bot` icon for the
   persona's current-state asset, plus one new surface (the detail modal), all reading
   from the same `agent.persona` relation:
   - `ChatHeader.tsx` — active chat header
   - `AgentSelector.tsx` — agent picker dialog
   - `ConversationList.tsx` `AgentSection` headers — flat roster/sidebar view (all
     agents/team members, avatar + name, per the sidebar reference image)
   - `AgentIdentityCard.tsx` — settings page; gains a "choose persona" picker sourced from
     the library, replacing/augmenting the raw `avatarUrl` upload
   - New: a persona detail modal (the "Experts Market" card) — avatar, tagline, Official
     badge, description, skill tags, example asset + caption, Fire / Assign Task Now

   All five surfaces consume one persona feed; no per-surface data modeling.

6. **Fallback.** Agents with no `personaId` (existing custom agents, or new ones created
   without picking a persona) keep today's behavior — initials avatar / generic icon. No
   migration is required for existing agents; this is additive.

## Art & product direction

Explicitly not a copy of the Omniwork reference — that UI reads as a dev-tool feature
list (raw tool-name chips like `hyperframes-cli`, `gsap`; a loose grid of unrelated
example thumbnails). The bar here is restraint, not more decoration:

- **`skillTags` are stored data, not necessarily rendered as raw chips.** The detail
  modal should present capability as a short, considered sentence or a small curated set
  of outcomes ("what this persona does for you"), not an exhaustive dump of underlying
  tool/package names — that's implementation detail leaking into product surface.
- **One hero example per persona (`exampleAssetUrl`), not a grid.** A single best example
  communicates competence; multiple mismatched examples read as random rather than
  curated. Schema already reflects this (singular field, not an array) — keep it that way.
- **One disciplined visual style across the whole roster** — consistent palette,
  proportions, and lighting per persona so the library reads as one designed product line,
  not independent clip-art. This is an art-direction brief to write before generating any
  Higgsfield assets, not a per-persona decision.
- **Animation as restraint.** The idle → thinking → responding transition should be a
  small, confident shift (closer to a breathing/settling motion) rather than a cartoon
  flourish — it needs to feel like a real state change, not a gimmick.

## Scope of this round

- Animated from the start, by explicit choice — static-first was considered and rejected
  in favor of shipping the state-machine animation from day one. The schema and asset
  pipeline are built for three states per persona up front, even though it means no
  persona ships until all three assets exist for it.
- Persona library starts small (the 3 default agents: Disco, Saarthi PM, Architect) and
  is expected to grow (Omniwork-style roster), authored centrally.
- No tenant-facing persona authoring UI.

## Open questions for implementation planning

- Exact SSE/WebSocket event → animation state mapping (what counts as "thinking" vs
  "responding" in the current event stream) needs to be nailed down against the actual
  orchestrator event types before implementation.
- Asset format for animation states (short looping WebP/GIF vs. sprite atlas + CSS) not
  yet decided — affects both Higgsfield generation prompts and client rendering code.
