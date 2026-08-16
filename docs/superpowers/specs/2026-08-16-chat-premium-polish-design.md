# Chat premium polish — design system, message thread, input bar, clarification wizard

## Context

Reference screenshots (a "Supercomputer"-style AI product) showed a much more polished
chat surface than ours: collapsible reasoning/tool traces, a refined input bar with
`/` and `@` triggers, and a paginated multi-question clarification flow used to avoid
generating output on ambiguous requests. The full reference also included a tab-based
workspace shell, a cost-aware model picker, a credits ledger, and asset galleries —
those are out of scope here and tracked as separate future sub-projects (see Scope).

This is the first of several sub-projects. It covers the pieces that are pure frontend
polish on existing components, plus the one new interaction primitive (the clarification
wizard) that pulls its weight because it reuses HITL plumbing we already have.

## Scope

**In scope (this spec):**
1. Design tokens — refined hairlines/radius, both light and dark themes, existing teal/cyan accent kept
2. Message thread polish — collapsed `Worked for Ns` trace summary, `Waiting for your reply` state, theme-token colors for user bubbles
3. Input bar — `/` skills-and-employees palette, `@` mentions palette, scroll-to-bottom button, pill shape
4. Clarification wizard — new `ClarificationCard` UI + `Message.clarificationRequest` type + Mastra suspend/resume step + a tool the platform agent can call mid-conversation

**Explicitly out of scope (future sub-projects, not designed here):**
- Model picker + autonomy-mode selector (needs agent-orchestrator routing)
- Credits/usage ledger (no usage-metered billing exists today, only subscription billing)
- Per-conversation generation gallery + lightbox
- Global cross-conversation asset library modal
- Tab-based workspace shell (new-tab launcher, folders, apps/games)

## Decisions

- **Theme-aware, not forced-dark.** The chat continues to follow the app's existing
  light/dark toggle (`.dark` class in `globals.css`). Both palettes get more refined
  hairline borders and radii; we are not committing to a single always-dark chat.
- **Keep the existing teal/cyan accent** (`--ring`, `--chart-1` in `globals.css`). The
  reference's lime/yellow-green is a different product's brand color; carrying over the
  *pattern* (one accent, used sparingly) matters more than the literal hue.
- **Keep Geist sans-serif**, not the reference's serif body text. `--font-display:
  var(--font-instrument-serif)` already exists in `globals.css` but is unused; we are
  deliberately not adopting it here to avoid diverging from the rest of the product's
  typography. UI chrome and message body both stay on Geist.
- **Clarification wizard ships with real backend wiring**, not a frontend-only mock.
  It follows the exact `suspend`/`resume` HITL pattern already implemented in
  `apps/agent-orchestrator/src/mastra/workflows/pmWorkflow.ts` (`prdStep`, `roadmapStep`),
  rather than inventing a new mechanism.

## Design

### 1. Design tokens (`apps/web/app/globals.css`)

- Add `--radius-pill: 999px` to the `@theme inline` block for the input bar and any
  future pill-shaped controls.
- Soften hairline borders: dark theme `--border` moves from `oklch(1 0 0 / 10%)` to
  `oklch(1 0 0 / 6%)`; add an equivalent light-theme adjustment (light theme `--border`
  currently `oklch(0.922 0 0)` — introduce a slightly lower-contrast variant for
  chat-internal dividers specifically, e.g. a new `--color-border-tertiary` token, since
  `ToolCallCard.tsx` already references `var(--color-border-tertiary, #222)` as a
  fallback-only value today — it should become a real token instead of a hardcoded
  fallback).
- No new accent color. No font changes.

### 2. Message thread (`ThinkingIndicator.tsx`, `ToolCallCard.tsx`, `MessageItem.tsx`)

- `ThinkingIndicator.tsx`: once a response finishes (no longer streaming, had tool
  calls and/or took >2s), render a collapsed one-line summary — `Worked for Ns` with a
  chevron — that expands to show the historical tool-call trace. This is new state
  (elapsed-time tracking) added to the existing component, not a new component.
- While still active, collapse the current two-line `AgentOrb` + message layout into a
  single row — `Working for Ns · Thinking it through` (bullet-separated, icon inline) —
  matching the reference's active-state treatment; the two-row layout is reserved for
  the finished/collapsed summary above.
- The `Thinking it through` reasoning block itself truncates by default with a
  `Show more` expand affordance when its content exceeds ~3 lines, independent of the
  outer `Worked for Ns` collapse — this is a second, nested disclosure level, not the
  same toggle.
- Add a `Waiting for your reply` status variant, shown when a `ClarificationCard` (see
  §4) is pending — replaces the `Thinking it through` line while blocked on the user,
  using the existing accent color for the label text.
- `ToolCallCard.tsx` already matches the reference pattern (collapsible, icon + label,
  loading dots → checkmark). Only change: replace the hardcoded `#111`/`#222` inline
  style fallbacks with the real tokens from §1.
- `MessageItem.tsx`: replace the hardcoded `#1a1a1a` / `#2a2a2a` / `#e8e8e8` user-bubble
  colors with theme tokens (`bg-muted`, `border-border`, `text-foreground` equivalents)
  so the bubble looks correct in light mode too, since it's currently dark-only hardcoded
  colors regardless of app theme. Also add truncation (`…` + expand-on-click) for very
  long user messages, matching the reference's collapsed user bubbles.

### 3. Input bar (`ChatInput.tsx`)

- Change the outer container from `rounded-2xl` to `rounded-[var(--radius-pill)]` (or
  Tailwind arbitrary value) to match the reference's pill shape.
- Add `/`-trigger detection in the textarea's `onChange`: when the text at the cursor
  matches `/\/(\w*)$/`, open a new `SlashPalette` component (built on the existing
  `DropdownMenu` primitive already imported) listing skills/AI-employees. Data source:
  existing `AgentSelector.tsx`'s agent-fetching logic — reuse rather than duplicate.
- Add `@`-trigger detection the same way, opening a `MentionPalette` for
  elements/documents. Empty-state row (`No mentions match "x"`) styled the same as a
  real row, dimmed.
- Add a scroll-to-bottom floating button in the parent scroll container (`page.tsx` /
  `MessageThread.tsx`), shown when the thread is scrolled up from the bottom, positioned
  just above the input bar.
- Add a `Use employee` quick-launch pill next to the existing `+` button, opening the
  same `SlashPalette` pre-filtered to the "AI employees" group — a shortcut into the
  same data/UI as the `/` trigger rather than a separate mechanism.
- Add the small centered disclaimer line below the input bar (reference shows
  "LLMs can make mistakes and calls cost credits" — ours reads "AI can make mistakes.
  Please verify important information." since we have no credits system yet; copy is
  swappable once the credits sub-project ships).
- Deferred, not dropped: the reference's above-input recent-message/suggestion
  dropdown (stacked truncated past prompts shown while typing). Its data contract is
  unclear from screenshots alone (recent messages? saved prompts? autocomplete?) —
  building it now risks guessing the wrong shape. Flagging explicitly so it isn't lost;
  revisit once we know what it's sourced from.
- No changes needed to the send↔stop swap — `ChatInput.tsx` already implements this
  (`isStreaming ? <StopCircle/> : <SendHorizontal/>`).

### 4. Clarification wizard

**Type** (`apps/web/components/platform/chat/types.ts`):

```ts
export interface ClarificationOption {
  label: string;
  rationale?: string;
}

export interface ClarificationQuestion {
  prompt: string;
  options: ClarificationOption[];
  allowFreeText?: boolean;
  allowSkip?: boolean;
}

export interface ClarificationRequest {
  id: string;
  questions: ClarificationQuestion[];
  status: 'pending' | 'answered' | 'skipped';
  answers?: Array<{ selectedIndex?: number; freeText?: string; skipped?: boolean }>;
}
```

Added as `Message.clarificationRequest?: ClarificationRequest`.

**Frontend** (`ClarificationCard.tsx`, new file, sibling to `ApprovalCard.tsx`):
paginated card (`1/N`, `‹`/`›`), numbered options with bold label + muted rationale,
free-text override row, `Skip` (bound to `Esc`) / `Continue` or `Submit` (bound to
`Enter`) footer — same structural shell as `ApprovalCard.tsx` (header/body/footer,
pending-vs-decided render branches) generalized to N questions instead of one
tool-call approval. Rendered from `MessageItem.tsx` in place of the currently
dead-code `{false && message.approvalRequest && ...}` block — that path is disabled
today and this replaces it rather than adding a second parallel mechanism.

**Backend** (`apps/agent-orchestrator/src/mastra`): a new step following the same
`suspend`/`resume` shape as `prdStep`/`roadmapStep` in `pmWorkflow.ts` — `suspend`
carries the question list, `resume` carries the answer(s). Unlike `pmWorkflow.ts`'s
gates (which sit between fixed phases of a scripted workflow), this needs to be
callable by `platformAgent` mid-conversation as a tool, so it also needs a new tool
definition (`apps/agent-orchestrator/src/mastra/tools.ts`) the agent invokes when it
decides a request is ambiguous — analogous to how `ApprovalCard`'s underlying
approval-request tool works today, generalized from single yes/no to N multiple-choice
questions.

### Error handling

- If the agent-orchestrator process restarts mid-suspend, the resume data is lost same
  as today's PRD/roadmap gates — no new failure mode introduced, existing watchdog
  behavior (marks stalled `in_progress` tasks `blocked`) applies unchanged.
- Free-text override and `Skip` both resolve the `ClarificationCard` the same way
  `ApprovalCard`'s dismiss does — no new state machine needed beyond `pending` →
  `answered` | `skipped`.

### Testing

- Component-level: `ClarificationCard` rendering for pending/answered/skipped states,
  pagination between questions, keyboard shortcuts (`Esc`, `Enter`).
- Integration: one test mirroring `apps/agent-orchestrator/src/mastra/__tests__/serverTools.test.ts`
  pattern, exercising suspend → resume with a selected option and with free text.
- Manual: theme toggle (light/dark) visual check on all touched components, since this
  spec explicitly keeps theme-awareness rather than forcing dark mode.
