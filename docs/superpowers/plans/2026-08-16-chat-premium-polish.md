# Chat Premium Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the tenant-dashboard chat (message thread, input bar, design tokens) to match the reference screenshots' "premium" interaction language, and add a new multi-question clarification wizard the platform agent can trigger mid-conversation instead of guessing on ambiguous requests.

**Architecture:** Frontend-only polish for tasks 1–5 (design tokens, message thread, input bar, `/` and `@` palettes) built entirely on existing components in `apps/web/components/platform/chat/`. The clarification wizard (tasks 6–9) generalizes the existing MCP-approval gate mechanism (`pendingMcpApprovals` + `sseApprovalChannels` in `apps/agent-orchestrator/src/types.ts`) from a single yes/no decision to an ordered list of multiple-choice questions, reusing the same SSE-event-then-REST-resolve shape already proven by `/api/chat/approval`.

**Tech Stack:** Next.js App Router, React, Tailwind v4 (`@theme inline` tokens), Radix `DropdownMenu`, Mastra (`createTool`, `RequestContext`), Hono routes, `@tanstack/react-query`.

## Global Constraints

- Chat stays theme-aware (respects the app's existing `.dark` class toggle) — do not force a single always-dark theme.
- Keep the existing teal/cyan accent (`--ring`, `--chart-1` tokens in `apps/web/app/globals.css`) — no new accent color.
- Keep Geist sans-serif everywhere — do not adopt `--font-display` (Instrument Serif) for message body text.
- No credits/usage-metering copy or UI — the disclaimer line uses generic wording since no credits system exists yet.
- Follow existing patterns: Mastra tools read context via `execute: async (inputData, execContext) => execContext?.requestContext?.get(key)`, matching `apps/agent-orchestrator/src/mastra/tools/platform-capabilities.ts`.

---

## Task 1: Design tokens

**Files:**
- Modify: `apps/web/app/globals.css:7-50` (`@theme inline` block), `:52-85` (`:root`), `:87-120` (`.dark`)

**Interfaces:**
- Produces: `--radius-pill` (theme token), `--color-border-tertiary` (theme token, both light and dark values)

- [ ] **Step 1: Add `--radius-pill` to the `@theme inline` block**

In `apps/web/app/globals.css`, inside the `@theme inline { ... }` block (after line 49, `--radius-4xl: calc(var(--radius) + 16px);`), add:

```css
  --radius-pill: 999px;
  --color-border-tertiary: var(--border-tertiary);
```

- [ ] **Step 2: Add `--border-tertiary` value to `:root` (light theme)**

In the `:root { ... }` block (after line 69, `--border: oklch(0.922 0 0);`), add:

```css
  --border-tertiary: oklch(0.922 0 0 / 60%);
```

- [ ] **Step 3: Add `--border-tertiary` value to `.dark` (dark theme), softened from current hairline**

In the `.dark { ... }` block (after line 104, `--border: oklch(1 0 0 / 10%);`), add:

```css
  --border-tertiary: oklch(1 0 0 / 6%);
```

- [ ] **Step 4: Verify the build picks up the new tokens**

Run: `cd apps/web && pnpm exec tsc --noEmit -p . 2>&1 | head -20 && grep -n "radius-pill\|border-tertiary" app/globals.css`
Expected: both new declarations print, no new TypeScript errors (this is a CSS-only change).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): add pill-radius and border-tertiary design tokens for chat polish"
```

---

## Task 2: Message-thread trace polish (`ThinkingIndicator`, `ToolCallCard`)

**Files:**
- Modify: `apps/web/components/platform/chat/ThinkingIndicator.tsx`
- Modify: `apps/web/components/platform/chat/ToolCallCard.tsx:132-141` (token fallback cleanup)

**Interfaces:**
- Consumes: existing `ThinkingIndicatorProps` (`isRetrying`, `isStreaming`, `activeToolCalls`, `completedToolCalls`, `hasContent`) — unchanged
- Produces: `ThinkingIndicator` now also renders a collapsed `Worked for Ns` summary after streaming ends if it ran ≥2s or had tool calls; no prop signature change (elapsed time is tracked internally)

- [ ] **Step 1: Add elapsed-time tracking state to `ThinkingIndicator`**

In `apps/web/components/platform/chat/ThinkingIndicator.tsx`, add after the existing `useState` declarations (after line 43, `const [messageIndex, setMessageIndex] = useState(0);`):

```ts
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [elapsedSec, setElapsedSec] = useState(0);
    const [traceCollapsed, setTraceCollapsed] = useState(true);
```

- [ ] **Step 2: Track start time when streaming begins, freeze elapsed seconds when it ends**

Add a new `useEffect` after the existing thinking-message interval effect (after line 115, the `}, [isStreaming, thinkingMessages.length]);` closing the second `useEffect`):

```ts
    useEffect(() => {
        if (isStreaming && startedAt === null) {
            setStartedAt(Date.now());
        }
        if (!isStreaming && startedAt !== null) {
            setElapsedSec(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        }
    }, [isStreaming, startedAt]);
```

- [ ] **Step 3: Render the collapsed `Worked for Ns` summary once finished with tool calls**

Replace the `if (hasContent && !isSaveTool) return null;` line (line 117) with a branch that renders the collapsed summary instead of returning null when there were tool calls or the run took ≥2s:

```ts
    const hadTrace = completedToolCalls.length > 0 || elapsedSec >= 2;

    if (hasContent && !isSaveTool) {
        if (!hadTrace) return null;
        return (
            <button
                type="button"
                onClick={() => setTraceCollapsed(c => !c)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
                <svg
                    width="10" height="10" viewBox="0 0 10 10" fill="none"
                    className={cn("shrink-0 transition-transform", traceCollapsed ? "" : "rotate-90")}
                >
                    <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Worked for {elapsedSec}s</span>
                {!traceCollapsed && completedToolCalls.length > 0 && (
                    <span className="ml-2 flex flex-col gap-1 normal-case">
                        {completedToolCalls.map(tc => (
                            <ToolCallCard key={tc.id} toolName={tc.toolName} query={tc.query} status="done" results={tc.results} />
                        ))}
                    </span>
                )}
            </button>
        );
    }
```

- [ ] **Step 4: Combine the active-state icon + label onto a single row**

Replace the "Phase 2a — plain thinking" block (lines 172-185) so the label reads `Working for Ns · <thinking message>` while streaming with an elapsed counter, instead of just the rotating thinking message alone:

```ts
    // Phase 2a — plain thinking
    if (isStreaming) {
        const liveElapsed = startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
        return (
            <div className="flex items-start gap-4 animate-in fade-in duration-300">
                <AgentOrb size={40} state="thinking" />
                <div className="flex items-center gap-2 pt-1.5">
                    <PulsingDots />
                    <span className="text-sm text-[#c4b5fd] font-mono animate-in fade-in duration-500" key={messageIndex}>
                        {liveElapsed >= 2 ? `Working for ${liveElapsed}s · ` : ''}{thinkingMessages[messageIndex]}
                    </span>
                </div>
            </div>
        );
    }
```

- [ ] **Step 5: Import `cn` in `ThinkingIndicator.tsx`**

At the top of the file, change line 5 from:
```ts
import { cn } from "@/lib/utils";
```
It's already imported — verify it's used (it is now, in Step 3). No change needed if already present; otherwise add it.

- [ ] **Step 6: Replace `ToolCallCard.tsx` hardcoded color fallbacks with the new token**

In `apps/web/components/platform/chat/ToolCallCard.tsx`, lines 136-138, change:

```ts
        background: 'var(--color-background-secondary, #111)',
        border: '0.5px solid var(--color-border-tertiary, #222)',
```
to:
```ts
        background: 'var(--muted)',
        border: '0.5px solid var(--color-border-tertiary)',
```
and line 174, change `borderTop: '0.5px solid var(--color-border-tertiary, #222)'` to `borderTop: '0.5px solid var(--color-border-tertiary)'` (drop the hardcoded fallback now that Task 1 defines a real token).

- [ ] **Step 7: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors in `ThinkingIndicator.tsx` or `ToolCallCard.tsx`.

- [ ] **Step 8: Manual verification**

Run: `cd apps/web && pnpm dev`, open a tenant chat conversation, send a message that triggers `retrieve_documents` or `internet_search`. Confirm: (a) while streaming, the row reads `Working for Ns · <message>` after 2s; (b) once done, a collapsed `Worked for Ns` row with a chevron appears and expands to show completed tool calls.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/platform/chat/ThinkingIndicator.tsx apps/web/components/platform/chat/ToolCallCard.tsx
git commit -m "feat(web): collapse chat reasoning trace into a 'Worked for Ns' summary"
```

---

## Task 3: Theme-aware message bubbles + truncation

**Files:**
- Modify: `apps/web/components/platform/chat/MessageItem.tsx:91-100`

**Interfaces:**
- Consumes: existing `Message` type — unchanged
- Produces: no new props; visual-only change plus internal `expanded` state for long user messages

- [ ] **Step 1: Replace hardcoded user-bubble colors with theme tokens**

In `apps/web/components/platform/chat/MessageItem.tsx`, replace lines 92-99:

```tsx
                        className={cn(
                            "text-sm",
                            isUser
                                ? "px-5 py-4 bg-[#1a1a1a] border border-[#2a2a2a]/50 text-[#e8e8e8] leading-[1.55]"
                                : "text-[#d4d4d4] leading-[1.75] w-full"
                        )}
                        style={isUser ? { borderRadius: '18px 18px 4px 18px' } : undefined}
```
with:
```tsx
                        className={cn(
                            "text-sm",
                            isUser
                                ? "px-5 py-4 bg-muted border border-border/50 text-foreground leading-[1.55]"
                                : "text-foreground/90 leading-[1.75] w-full"
                        )}
                        style={isUser ? { borderRadius: '18px 18px 4px 18px' } : undefined}
```

- [ ] **Step 2: Add truncation state for long user messages**

Add `useState` import and truncation logic. Change the top import (line 2) from:
```tsx
'use client';

import { Terminal, Info, Image as ImageIcon, FileText } from "lucide-react";
```
to:
```tsx
'use client';

import { useState } from "react";
import { Terminal, Info, Image as ImageIcon, FileText } from "lucide-react";
```

Inside the component body, after line 43 (`const isSystem = ...`), add:

```ts
    const [userExpanded, setUserExpanded] = useState(false);
    const USER_TRUNCATE_LEN = 280;
    const isLongUserMessage = isUser && message.content.length > USER_TRUNCATE_LEN;
    const displayedUserContent = isLongUserMessage && !userExpanded
        ? message.content.slice(0, USER_TRUNCATE_LEN) + '…'
        : message.content;
```

- [ ] **Step 3: Render truncated content for user messages, with a click-to-expand toggle**

The markdown render branch (lines 91-130) currently renders `markdownContent` for both roles via `ReactMarkdown`. User messages don't need markdown — replace the ternary at line 56-58:

```ts
    const markdownContent = isAssistant && message.planResult
        ? message.planResult.summary
        : message.content;
```
with:
```ts
    const markdownContent = isAssistant && message.planResult
        ? message.planResult.summary
        : isUser ? displayedUserContent : message.content;
```

Then, inside the user-bubble `<div>` (the one styled in Step 1), after its content renders, add the expand toggle. Since user content today renders via `ReactMarkdown` for both roles, keep that as-is (it already handles plain text fine) and just append a toggle button conditionally — insert right after the closing `</ReactMarkdown>` tag's containing `<div>` (end of the block at line 129, before its closing `)}`):

```tsx
                        {isLongUserMessage && (
                            <button
                                type="button"
                                onClick={() => setUserExpanded(e => !e)}
                                className="text-xs text-muted-foreground hover:text-foreground underline mt-1"
                            >
                                {userExpanded ? 'Show less' : 'Show more'}
                            </button>
                        )}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 5: Manual verification**

Toggle the app's theme switcher (light/dark) on the chat page; confirm user bubbles render legibly in both. Send a >280-char message; confirm it truncates with a working "Show more"/"Show less" toggle.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/platform/chat/MessageItem.tsx
git commit -m "feat(web): theme-aware user message bubbles with long-message truncation"
```

---

## Task 4: Input bar — pill shape, scroll-to-bottom, quick-launch, disclaimer

**Files:**
- Modify: `apps/web/components/platform/chat/ChatInput.tsx:142-262`
- Modify: `apps/web/components/platform/chat/MessageThread.tsx:107-169`

**Interfaces:**
- Produces: `ChatInput` gains a new optional prop `onUseEmployee?: () => void` (fires the same handler the `/` palette's "AI employees" group would use — wired fully in Task 5)
- `MessageThread` gains internal scroll-to-bottom floating button; no prop changes

- [ ] **Step 1: Change the input container to a full pill radius**

In `apps/web/components/platform/chat/ChatInput.tsx`, line 157, change:
```tsx
                <div className="flex flex-col rounded-2xl border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">
```
to:
```tsx
                <div className="flex flex-col rounded-[var(--radius-pill)] border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">
```

Note: a full pill radius on a multi-line `<Textarea>` container looks wrong once the box grows tall (the top/bottom pill curvature would clip content). Cap it: the container only gets the full pill radius while the textarea is single-line height. Simplify instead by using a large-but-fixed radius that reads as "pill" for the typical one-to-two-line input without breaking on multi-line: use `rounded-[28px]` instead of the CSS var for the container, and reserve `--radius-pill` for genuinely circular controls (buttons). Change Step 1's replacement to:
```tsx
                <div className="flex flex-col rounded-[28px] border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">
```

- [ ] **Step 2: Add `onUseEmployee` prop and a quick-launch pill next to `+`**

In `ChatInput.tsx`, add to `ChatInputProps` (after line 48, `onMediaClick?: ...`):
```ts
    onUseEmployee?: () => void;
```

Add to the destructured props (after line 61, `onMediaClick,`):
```ts
    onUseEmployee,
```

In the left-side button group (lines 189-214), after the closing `)}` of the attach `DropdownMenu` block, add:
```tsx
                                    {onUseEmployee && (
                                        <button
                                            type="button"
                                            onClick={onUseEmployee}
                                            className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                                                <rect x="3" y="5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                                                <circle cx="5.5" cy="8" r="0.6" fill="currentColor"/>
                                                <circle cx="8.5" cy="8" r="0.6" fill="currentColor"/>
                                                <line x1="7" y1="5" x2="7" y2="3.2" stroke="currentColor" strokeWidth="1"/>
                                                <circle cx="7" cy="2.6" r="0.6" fill="currentColor"/>
                                            </svg>
                                            Use employee
                                        </button>
                                    )}
```

- [ ] **Step 3: Add the disclaimer line below the input**

Replace the footer hint text (lines 256-258):
```tsx
                <p className="text-[10px] text-center text-muted-foreground mt-2">
                    Shift + Enter for a new line. Press Enter to send.
                </p>
```
with:
```tsx
                <p className="text-[10px] text-center text-muted-foreground/70 mt-2">
                    AI can make mistakes. Please verify important information.
                </p>
```

(The keyboard-shortcut hint moves to a `title` attribute on the send button instead, so it isn't lost — in the send `<button>` at line 235, add `title="Enter to send, Shift+Enter for a new line"`.)

- [ ] **Step 4: Add scroll-to-bottom floating button in `MessageThread.tsx`**

In `apps/web/components/platform/chat/MessageThread.tsx`, add scroll-position tracking. After line 30 (`const [freshUrls, setFreshUrls] = useState<Record<string, string>>({});`), add:
```ts
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
```

After the existing scroll-to-bottom-on-new-message `useEffect` (lines 38-42), add a scroll listener:
```ts
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => {
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            setShowScrollToBottom(distanceFromBottom > 200);
        };
        el.addEventListener('scroll', onScroll);
        return () => el.removeEventListener('scroll', onScroll);
    }, []);
```

Add the `useState` import — line 3 already imports `useEffect, useRef, useState` from `"react"`, so no import change needed.

At the end of the scrollable container, just before its closing `</div>` (line 167, right before line 168's outer `</div>`), add the floating button as a sibling positioned via the wrapping element. Since `MessageThread`'s root `<div ref={scrollRef}>` is itself the scroll container (line 108), the button needs a non-scrolling ancestor — wrap the existing return in a relative wrapper:

Change line 107-108 from:
```tsx
    return (
        <div ref={scrollRef} className="flex-1 px-4 md:px-8 py-4 overflow-y-auto custom-scrollbar">
```
to:
```tsx
    return (
        <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full px-4 md:px-8 py-4 overflow-y-auto custom-scrollbar">
```

And change the final closing tags (lines 168-170) from:
```tsx
            </div>
        </div>
    );
}
```
to:
```tsx
            </div>
        </div>
        {showScrollToBottom && (
            <button
                type="button"
                onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 h-8 w-8 rounded-full bg-muted border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 5.5L7 9.5L11 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            </button>
        )}
        </div>
    );
}
```

- [ ] **Step 5: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 6: Manual verification**

Open a conversation with enough messages to scroll; scroll up and confirm the floating down-arrow button appears and scrolling to bottom hides it again. Confirm the input bar renders as a rounded pill and the disclaimer line replaced the old shortcut hint.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/ChatInput.tsx apps/web/components/platform/chat/MessageThread.tsx
git commit -m "feat(web): pill-shaped chat input, scroll-to-bottom button, use-employee shortcut"
```

---

## Task 5: `/` skills palette and `@` mentions palette

**Files:**
- Create: `apps/web/components/platform/chat/SlashPalette.tsx`
- Create: `apps/web/components/platform/chat/MentionPalette.tsx`
- Modify: `apps/web/components/platform/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: `Agent` type from `apps/web/components/platform/agents/types.ts`, `api.get` from `@/lib/api`, `@tanstack/react-query`'s `useQuery` (same pattern as `AgentSelector.tsx`)
- Produces: `SlashPalette` component with props `{ query: string; onSelect: (agent: Agent) => void; onClose: () => void }`; `MentionPalette` component with props `{ query: string; onSelect: (label: string) => void; onClose: () => void }`

- [ ] **Step 1: Create `SlashPalette.tsx`**

```tsx
'use client';

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Bot } from "lucide-react";
import { Agent, AgentsResponse } from "../agents/types";

interface SlashPaletteProps {
    query: string;
    onSelect: (agent: Agent) => void;
    onClose: () => void;
}

export function SlashPalette({ query, onSelect, onClose }: SlashPaletteProps) {
    const { data, isLoading } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const activeAgents = (data?.data ?? []).filter(a => a.status === 'active');
    const filtered = query
        ? activeAgents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))
        : activeAgents;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-lg p-2 max-h-64 overflow-y-auto custom-scrollbar">
            <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Skills and AI employees
            </div>
            {isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                    No skills match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map(agent => (
                    <button
                        key={agent.id}
                        type="button"
                        onClick={() => { onSelect(agent); onClose(); }}
                        className="w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left hover:bg-muted/60 transition-colors"
                    >
                        <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                            <Bot className="h-4 w-4" />
                        </div>
                        <div className="flex flex-col overflow-hidden">
                            <span className="text-sm font-medium truncate">{agent.name}</span>
                            <span className="text-xs text-muted-foreground truncate">
                                {agent.description ?? `${agent.type} agent`}
                            </span>
                        </div>
                    </button>
                ))
            )}
        </div>
    );
}
```

- [ ] **Step 2: Create `MentionPalette.tsx`**

```tsx
'use client';

import { AtSign } from "lucide-react";

interface MentionPaletteProps {
    query: string;
    onSelect: (label: string) => void;
    onClose: () => void;
}

// Elements available to @-mention. Static for now — document/task mentions are a
// separate data-wiring effort once this UI shell is confirmed.
const ELEMENTS: string[] = [];

export function MentionPalette({ query, onSelect, onClose }: MentionPaletteProps) {
    const filtered = query
        ? ELEMENTS.filter(e => e.toLowerCase().includes(query.toLowerCase()))
        : ELEMENTS;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-lg p-2">
            {filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground flex items-center gap-2">
                    <AtSign className="h-3.5 w-3.5" />
                    No mentions match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map(label => (
                    <button
                        key={label}
                        type="button"
                        onClick={() => { onSelect(label); onClose(); }}
                        className="w-full px-2 py-2 rounded-xl text-left text-sm hover:bg-muted/60 transition-colors"
                    >
                        {label}
                    </button>
                ))
            )}
        </div>
    );
}
```

- [ ] **Step 3: Wire trigger detection into `ChatInput.tsx`**

Add imports at the top of `ChatInput.tsx` (after the existing `FEATURE_FLAGS` import, line 20):
```ts
import { SlashPalette } from "./SlashPalette";
import { MentionPalette } from "./MentionPalette";
import { Agent } from "../agents/types";
```

Add state after `const [content, setContent] = useState("");` (line 67):
```ts
    const [paletteMode, setPaletteMode] = useState<'slash' | 'mention' | null>(null);
    const [paletteQuery, setPaletteQuery] = useState('');
```

Replace the `<Textarea>`'s `onChange` handler (line 181, `onChange={(e) => setContent(e.target.value)}`) with a function that also detects `/` and `@` triggers at the cursor:
```tsx
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setContent(value);
                                    const cursor = e.target.selectionStart ?? value.length;
                                    const upToCursor = value.slice(0, cursor);
                                    const slashMatch = upToCursor.match(/(?:^|\s)\/(\w*)$/);
                                    const mentionMatch = upToCursor.match(/(?:^|\s)@(\w*)$/);
                                    if (slashMatch) {
                                        setPaletteMode('slash');
                                        setPaletteQuery(slashMatch[1]);
                                    } else if (mentionMatch) {
                                        setPaletteMode('mention');
                                        setPaletteQuery(mentionMatch[1]);
                                    } else {
                                        setPaletteMode(null);
                                    }
                                }}
```

Wrap the outer pill container (the `<div className="flex flex-col rounded-[28px] ...">` from Task 4 Step 1) in a `relative` positioning context so the palettes can anchor to it — change that div's className to prepend `relative `:
```tsx
                <div className="relative flex flex-col rounded-[28px] border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">
```

Immediately inside that div, before `<AttachmentStrip .../>` (line 159), render the active palette:
```tsx
                    {paletteMode === 'slash' && (
                        <SlashPalette
                            query={paletteQuery}
                            onSelect={(agent: Agent) => {
                                setContent(c => c.replace(/(?:^|\s)\/(\w*)$/, ` @${agent.name} `));
                            }}
                            onClose={() => setPaletteMode(null)}
                        />
                    )}
                    {paletteMode === 'mention' && (
                        <MentionPalette
                            query={paletteQuery}
                            onSelect={(label: string) => {
                                setContent(c => c.replace(/(?:^|\s)@(\w*)$/, ` @${label} `));
                            }}
                            onClose={() => setPaletteMode(null)}
                        />
                    )}
```

- [ ] **Step 4: Wire the `Use employee` button (Task 4) to open the slash palette pre-filtered**

In `ChatInput.tsx`'s JSX where `onUseEmployee` is consumed (added in Task 4 Step 2), pass:
```tsx
                                        onUseEmployee={() => { setPaletteMode('slash'); setPaletteQuery(''); }}
```
This requires moving the `onUseEmployee` prop out of destructured props (it was Task 4's plumbing) and instead defining it inline here — in `ChatInput`'s function body, before the `return`, add:
```ts
    const handleUseEmployee = () => { setPaletteMode('slash'); setPaletteQuery(''); };
```
and pass `onUseEmployee={handleUseEmployee}` to the button usage from Task 4 Step 2 instead of expecting it as an external prop. Remove the `onUseEmployee` entry from `ChatInputProps` and the destructure added in Task 4 Step 2 (this internalizes it — no parent wiring needed since the slash palette already lives inside `ChatInput`).

- [ ] **Step 5: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors. `Agent` type import must resolve from `../agents/types`.

- [ ] **Step 6: Manual verification**

In the chat input, type `/` — confirm the skills palette opens listing active agents, filters as you type, and closes on selection (inserting `@AgentName ` into the textarea). Type `@` with no matches — confirm the `No mentions match "..."` empty state renders. Click `Use employee` — confirm it opens the same slash palette.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/SlashPalette.tsx apps/web/components/platform/chat/MentionPalette.tsx apps/web/components/platform/chat/ChatInput.tsx
git commit -m "feat(web): add / skills palette and @ mentions palette to chat input"
```

---

## Task 6: Clarification wizard — types and `ClarificationCard` UI

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts`
- Create: `apps/web/components/platform/chat/ClarificationCard.tsx`

**Interfaces:**
- Produces: `ClarificationOption { label: string; rationale?: string }`, `ClarificationQuestion { prompt: string; options: ClarificationOption[]; allowFreeText?: boolean; allowSkip?: boolean }`, `ClarificationRequest { id: string; questions: ClarificationQuestion[]; status: 'pending' | 'answered' | 'skipped' }`, `Message.clarificationRequest?: ClarificationRequest`
- `ClarificationCard` component: `{ request: ClarificationRequest; onAnswer: (answer: { questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }) => void }`

- [ ] **Step 1: Add clarification types to `types.ts`**

In `apps/web/components/platform/chat/types.ts`, after the existing `ApprovalRequest` interface (after line 23), add:

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
    answeredAt?: string;
}
```

Add `clarificationRequest?: ClarificationRequest;` to the `Message` interface, after `approvalRequest?: ApprovalRequest;` (line 84).

- [ ] **Step 2: Write the failing component test**

Create `apps/web/components/platform/chat/__tests__/ClarificationCard.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarificationCard } from '../ClarificationCard';
import type { ClarificationRequest } from '../types';

const request: ClarificationRequest = {
    id: 'clar-1',
    status: 'pending',
    questions: [
        {
            prompt: 'What length/format do you want?',
            options: [
                { label: '~30s vertical 9:16', rationale: 'Best for Reels/Shorts/TikTok' },
                { label: '~60s vertical 9:16', rationale: 'A fuller story arc' },
            ],
            allowFreeText: true,
            allowSkip: true,
        },
        {
            prompt: 'Which visual style?',
            options: [
                { label: 'Reuse paper-plane concept', rationale: 'Same branding' },
            ],
            allowFreeText: true,
            allowSkip: true,
        },
    ],
};

test('renders first question with pagination and steps to Submit on the last question', () => {
    const onAnswer = jest.fn();
    render(<ClarificationCard request={request} onAnswer={onAnswer} />);

    expect(screen.getByText('What length/format do you want?')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('Continue')).toBeInTheDocument();

    fireEvent.click(screen.getByText('~30s vertical 9:16'));
    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByText('Which visual style?')).toBeInTheDocument();
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Reuse paper-plane concept'));
    fireEvent.click(screen.getByText('Submit'));

    expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndex: 0 });
    expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 1, selectedIndex: 0 });
});

test('Skip resolves the current question with skipped: true', () => {
    const onAnswer = jest.fn();
    render(<ClarificationCard request={request} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('Skip'));
    expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, skipped: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && pnpm exec jest components/platform/chat/__tests__/ClarificationCard.test.tsx`
Expected: FAIL — `Cannot find module '../ClarificationCard'`

- [ ] **Step 4: Implement `ClarificationCard.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ClarificationRequest } from './types';

interface ClarificationCardProps {
    request: ClarificationRequest;
    onAnswer: (answer: { questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }) => void;
}

export function ClarificationCard({ request, onAnswer }: ClarificationCardProps) {
    const [pageIndex, setPageIndex] = useState(0);
    const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, number>>({});
    const [freeText, setFreeText] = useState('');

    if (request.status !== 'pending') {
        return (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1 px-2 bg-muted/30 rounded-lg border border-border/20 w-fit">
                <span>{request.status === 'answered' ? 'Answered' : 'Skipped'}</span>
            </div>
        );
    }

    const total = request.questions.length;
    const question = request.questions[pageIndex];
    const selectedIndex = selectedByQuestion[pageIndex];
    const isLast = pageIndex === total - 1;

    const commitCurrent = () => {
        const trimmedFreeText = freeText.trim();
        const answer = trimmedFreeText
            ? { questionIndex: pageIndex, freeText: trimmedFreeText }
            : { questionIndex: pageIndex, selectedIndex };
        onAnswer(answer);
        setFreeText('');
        if (!isLast) setPageIndex(p => p + 1);
    };

    const handleSkip = () => {
        onAnswer({ questionIndex: pageIndex, skipped: true });
        setFreeText('');
        if (!isLast) setPageIndex(p => p + 1);
    };

    return (
        <div className="rounded-2xl border border-border bg-card overflow-hidden my-3 max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="px-4 py-3 flex items-center justify-between">
                <h4 className="text-sm font-medium">{question.prompt}</h4>
                <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 ml-3">
                    <button
                        type="button"
                        disabled={pageIndex === 0}
                        onClick={() => setPageIndex(p => Math.max(0, p - 1))}
                        className="disabled:opacity-30"
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span>{pageIndex + 1}/{total}</span>
                    <button
                        type="button"
                        disabled={pageIndex === total - 1}
                        onClick={() => setPageIndex(p => Math.min(total - 1, p + 1))}
                        className="disabled:opacity-30"
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <div className="px-4 pb-3 space-y-1.5">
                {question.options.map((opt, i) => (
                    <button
                        key={opt.label}
                        type="button"
                        onClick={() => setSelectedByQuestion(prev => ({ ...prev, [pageIndex]: i }))}
                        className={cn(
                            "w-full text-left rounded-xl px-3 py-2.5 border transition-colors",
                            selectedIndex === i
                                ? "border-primary/40 bg-primary/5"
                                : "border-transparent bg-muted/40 hover:bg-muted/60"
                        )}
                    >
                        <div className="text-sm font-medium">{i + 1}. {opt.label}</div>
                        {opt.rationale && (
                            <div className="text-xs text-muted-foreground mt-0.5">{opt.rationale}</div>
                        )}
                    </button>
                ))}
                {question.allowSkip && (
                    <div className="text-sm text-muted-foreground px-3 py-1">
                        {question.options.length + 1}. Something else
                    </div>
                )}
            </div>

            <div className="border-t border-border px-4 py-3 flex items-center gap-2">
                {question.allowFreeText && (
                    <input
                        value={freeText}
                        onChange={(e) => setFreeText(e.target.value)}
                        placeholder="No, and tell what to do differently"
                        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                    />
                )}
                <div className="flex items-center gap-2 shrink-0">
                    {question.allowSkip && (
                        <button type="button" onClick={handleSkip} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                            Skip
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={commitCurrent}
                        disabled={selectedIndex === undefined && !freeText.trim()}
                        className="h-8 px-4 rounded-full bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
                    >
                        {isLast ? 'Submit' : 'Continue'}
                    </button>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec jest components/platform/chat/__tests__/ClarificationCard.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/components/platform/chat/ClarificationCard.tsx apps/web/components/platform/chat/__tests__/ClarificationCard.test.tsx
git commit -m "feat(web): add ClarificationCard paginated multi-question wizard component"
```

---

## Task 7: Backend — clarification suspend/resolve plumbing

**Files:**
- Modify: `apps/agent-orchestrator/src/types.ts:78-83`
- Modify: `apps/agent-orchestrator/src/routes/sessions.ts`
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:139-147`

**Interfaces:**
- Produces: `pendingClarifications: Map<string, { resolve: (answer: ClarificationAnswer) => void; timer: ReturnType<typeof setTimeout> }>`, `ClarificationAnswer = { questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }[]`
- `requestContext` gains `'sendEvent'` (the `sendEvent` closure) and `'sessionId'` keys, settable/gettable via `.set`/`.get`, consumed by Task 8's tool
- New route: `POST /api/chat/clarification` (mirrors `/api/chat/approval`)

- [ ] **Step 1: Add `pendingClarifications` map to `types.ts`**

In `apps/agent-orchestrator/src/types.ts`, after line 83 (`export const sseApprovalChannels = ...`), add:

```ts
// Mid-conversation clarification-question state. Generalizes the MCP write-tool
// approval gate above (single boolean) to an ordered array of per-question answers
// collected across a paginated ClarificationCard in the UI.
export interface ClarificationAnswer {
  questionIndex: number
  selectedIndex?: number
  freeText?: string
  skipped?: boolean
}

export const pendingClarifications = new Map<string, {
  resolve: (answers: ClarificationAnswer[]) => void
  timer: ReturnType<typeof setTimeout>
  expectedCount: number
  collected: ClarificationAnswer[]
}>()
```

- [ ] **Step 2: Add the `/api/chat/clarification` resolve endpoint**

In `apps/agent-orchestrator/src/routes/sessions.ts`, update the import (line 3) to include `pendingClarifications`:
```ts
import { getAllowedOrigin, INTERNAL_SERVICE_KEY, sseApprovalChannels, pendingMcpApprovals, pendingClarifications } from '../types.js'
```

Add a new route after the existing `/api/chat/approval` handler (after line 95, the closing `})`):

```ts
// ─── Clarification answer — called by frontend as each ClarificationCard question is answered ──
sessionsRouter.post('/api/chat/clarification', async (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)

  try { await validateToken(token) } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)
  }

  let body: { clarificationId?: unknown; questionIndex?: unknown; selectedIndex?: unknown; freeText?: unknown; skipped?: unknown }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid_body' }, 400, corsHeaders) }

  const clarificationId = typeof body.clarificationId === 'string' ? body.clarificationId.trim() : ''
  const questionIndex = typeof body.questionIndex === 'number' ? body.questionIndex : -1
  if (!clarificationId || questionIndex < 0) {
    return c.json({ ok: false, error: 'clarificationId and questionIndex required' }, 400, corsHeaders)
  }

  const pending = pendingClarifications.get(clarificationId)
  if (!pending) return c.json({ ok: false, error: 'clarification_not_found' }, 404, corsHeaders)

  pending.collected.push({
    questionIndex,
    selectedIndex: typeof body.selectedIndex === 'number' ? body.selectedIndex : undefined,
    freeText: typeof body.freeText === 'string' ? body.freeText : undefined,
    skipped: body.skipped === true,
  })

  if (pending.collected.length >= pending.expectedCount) {
    clearTimeout(pending.timer)
    pendingClarifications.delete(clarificationId)
    pending.resolve(pending.collected)
  }

  return c.json({ ok: true, remaining: Math.max(0, pending.expectedCount - pending.collected.length) }, 200, corsHeaders)
})
```

- [ ] **Step 3: Pass `sendEvent` and `sessionId` into `requestContext`**

In `apps/agent-orchestrator/src/routes/chatStream.ts`, after line 144 (`requestContext.set('userId', internalUserId)`), add:

```ts
    requestContext.set('sendEvent', sendEvent)
    requestContext.set('sessionId', sessionId)
```

- [ ] **Step 4: Type-check the orchestrator**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no new errors. `validateToken` is already imported in `sessions.ts` (line 4) — confirm no duplicate-import issue.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/types.ts apps/agent-orchestrator/src/routes/sessions.ts apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(agent-orchestrator): add clarification-answer resolve endpoint and requestContext plumbing"
```

---

## Task 8: Backend — `ask_clarifying_questions` Mastra tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/askClarifyingQuestions.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: `requestContext.get('sendEvent')`, `requestContext.get('sessionId')`, `requestContext.get('tenantId')` — all set in Task 7 Step 3
- Produces: `askClarifyingQuestionsTool` (Mastra `createTool`), exported and added to `SERVER_TOOLS` under the key `ask_clarifying_questions`

- [ ] **Step 1: Create the tool**

Create `apps/agent-orchestrator/src/mastra/tools/askClarifyingQuestions.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { pendingClarifications } from '../../types.js'

const CLARIFICATION_TIMEOUT_MS = 120_000

// Lets the platform agent pause mid-conversation to ask 1+ multiple-choice
// clarifying questions instead of generating output on an ambiguous request.
// Mirrors the MCP write-tool approval gate (sessions.ts /mcp/approval-request)
// but generalized from a single yes/no decision to N structured answers.
export const askClarifyingQuestionsTool = createTool({
  id: 'ask_clarifying_questions',
  description:
    'Pause and ask the user one or more multiple-choice clarifying questions before proceeding ' +
    'with an ambiguous or underspecified request. Use this instead of guessing when the user\'s ' +
    'intent could reasonably resolve to more than one distinct output.',
  inputSchema: z.object({
    questions: z.array(z.object({
      prompt: z.string().describe('The question to ask'),
      options: z.array(z.object({
        label: z.string(),
        rationale: z.string().optional(),
      })).min(1),
      allowFreeText: z.boolean().optional().default(true),
      allowSkip: z.boolean().optional().default(true),
    })).min(1),
  }),
  execute: async (inputData, execContext) => {
    const sendEvent = execContext?.requestContext?.get('sendEvent') as
      ((event: string, data: object) => void) | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined

    if (!sendEvent || !sessionId) {
      return { answers: [], error: 'no_active_session' }
    }

    const clarificationId = crypto.randomUUID()
    sendEvent('clarification_request', { clarificationId, questions: inputData.questions })

    const answers = await new Promise<Array<{ questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }>>((resolve) => {
      const timer = setTimeout(() => {
        pendingClarifications.delete(clarificationId)
        resolve([])
      }, CLARIFICATION_TIMEOUT_MS)
      pendingClarifications.set(clarificationId, {
        resolve,
        timer,
        expectedCount: inputData.questions.length,
        collected: [],
      })
    })

    return {
      answers: answers.map((a, i) => ({
        prompt: inputData.questions[a.questionIndex]?.prompt ?? `question ${i}`,
        selectedLabel: a.selectedIndex !== undefined
          ? inputData.questions[a.questionIndex]?.options[a.selectedIndex]?.label
          : undefined,
        freeText: a.freeText,
        skipped: a.skipped ?? false,
      })),
    }
  },
})
```

- [ ] **Step 2: Register the tool on `platformAgent`**

In `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`, add the import after line 16 (`import { platformCapabilityTools } from '../tools/platform-capabilities.js'`):
```ts
import { askClarifyingQuestionsTool } from '../tools/askClarifyingQuestions.js'
```

Add it to `SERVER_TOOLS` (in the object starting at line 81), after the `web_fetch` entry (after line 156, the tool's closing `}),`):
```ts
  ask_clarifying_questions: askClarifyingQuestionsTool,
```

- [ ] **Step 3: Write a unit test for the tool's resolve path**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/askClarifyingQuestions.test.ts`, following the existing pattern in `apps/agent-orchestrator/src/mastra/__tests__/serverTools.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { askClarifyingQuestionsTool } from '../askClarifyingQuestions.js'
import { pendingClarifications } from '../../../types.js'

describe('askClarifyingQuestionsTool', () => {
  it('resolves once all questions are answered via pendingClarifications', async () => {
    const sendEvent = vi.fn()
    const requestContext = {
      get: (key: string) => (key === 'sendEvent' ? sendEvent : key === 'sessionId' ? 'session-1' : undefined),
    }

    const input = {
      questions: [
        { prompt: 'Length?', options: [{ label: '30s' }, { label: '60s' }], allowFreeText: true, allowSkip: true },
      ],
    }

    const resultPromise = askClarifyingQuestionsTool.execute!(input as any, { requestContext } as any)

    // Simulate the frontend resolving the single pending question
    await vi.waitFor(() => expect(pendingClarifications.size).toBe(1))
    const [[clarificationId, pending]] = pendingClarifications.entries()
    pending.collected.push({ questionIndex: 0, selectedIndex: 1 })
    pending.resolve(pending.collected)
    pendingClarifications.delete(clarificationId)

    const result = await resultPromise
    expect(sendEvent).toHaveBeenCalledWith('clarification_request', expect.objectContaining({ questions: input.questions }))
    expect((result as any).answers[0].selectedLabel).toBe('60s')
  })

  it('returns no_active_session when sendEvent/sessionId are missing', async () => {
    const requestContext = { get: () => undefined }
    const result = await askClarifyingQuestionsTool.execute!({ questions: [] } as any, { requestContext } as any)
    expect((result as any).error).toBe('no_active_session')
  })
})
```

- [ ] **Step 4: Run the test**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/__tests__/askClarifyingQuestions.test.ts`
Expected: PASS (2 tests). If the repo's test runner differs from `vitest` (check `apps/agent-orchestrator/package.json`'s `"test"` script first), use that command instead.

- [ ] **Step 5: Type-check**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/askClarifyingQuestions.ts apps/agent-orchestrator/src/mastra/tools/__tests__/askClarifyingQuestions.test.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(agent-orchestrator): add ask_clarifying_questions tool for platformAgent"
```

---

## Task 9: Frontend wiring — SSE event, `sendClarificationAnswer`, render in chat

**Files:**
- Modify: `apps/web/hooks/useChat.ts`
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`
- Modify: `apps/web/components/platform/chat/MessageThread.tsx`
- Modify: `apps/web/components/platform/chat/MessageItem.tsx`

**Interfaces:**
- Consumes: `ClarificationCard` from Task 6, `ClarificationRequest`/`ClarificationQuestion` types from Task 6
- Produces: `useChat` gains `onClarificationRequired?: (id: string, questions: ClarificationQuestion[]) => void` option and `sendClarificationAnswer: (clarificationId: string, questionIndex: number, answer: {selectedIndex?: number; freeText?: string; skipped?: boolean}) => Promise<boolean>` return value

- [ ] **Step 1: Add the SSE event type and callback to `useChat.ts`**

In `apps/web/hooks/useChat.ts`, add an import for the question type:
```ts
import type { ClarificationQuestion } from '@/components/platform/chat/types';
```

Add to `UseChatOptions` (after line 22, `onApprovalRequired?: ...`):
```ts
    onClarificationRequired?: (clarificationId: string, questions: ClarificationQuestion[]) => void;
```

Add to `UseChatReturn` (after line 27, `sendApproval: ...`):
```ts
    sendClarificationAnswer: (clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }) => Promise<boolean>;
```

Destructure the new option (after line 44, `onApprovalRequired,`):
```ts
        onClarificationRequired,
```

Add its ref (after line 65, `const onApprovalRequiredRef = ...`):
```ts
    const onClarificationRequiredRef = useRef(onClarificationRequired);
```
and set it (after line 76, `onApprovalRequiredRef.current = onApprovalRequired;`):
```ts
    onClarificationRequiredRef.current = onClarificationRequired;
```

Add a new `case` to the SSE event switch (after the `case 'approval_request':` block, after line 308's closing `}`):
```ts
                        case 'clarification_request': {
                            onClarificationRequiredRef.current?.(
                                payload.clarificationId as string,
                                (payload.questions as ClarificationQuestion[]) ?? [],
                            );
                            break;
                        }
```

Add `sendClarificationAnswer` alongside `sendApproval` (after line 375, the closing `}, []);` of `sendApproval`):
```ts
    const sendClarificationAnswer = useCallback(async (
        clarificationId: string,
        questionIndex: number,
        answer: { selectedIndex?: number; freeText?: string; skipped?: boolean },
    ): Promise<boolean> => {
        const { accessToken } = getAuthTokens();
        if (!accessToken) return false;

        try {
            const res = await fetch(`${CHAT_ENDPOINT}/clarification`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ clarificationId, questionIndex, ...answer }),
            });
            return res.ok;
        } catch {
            return false;
        }
    }, []);
```

Add it to the returned object (after line 381, `sendApproval,`):
```ts
        sendClarificationAnswer,
```

- [ ] **Step 2: Wire the event into `useChatStream.ts`**

In `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts`, add the import (after line 8):
```ts
import type { ClarificationRequest, ClarificationQuestion } from '@/components/platform/chat/types';
```

Destructure `sendClarificationAnswer` from `useChat`'s return (line 46, alongside `sendApproval`):
```ts
    const { sendMessage: sendChatMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying } = useChat({
```

Add the `onClarificationRequired` handler to the `useChat` options object (after the `onApprovalRequired` callback, after line 167's closing `}, [queryClient]),`):
```ts
        onClarificationRequired: useCallback((clarificationId: string, questions: ClarificationQuestion[]) => {
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const msg: Message = {
                    id: crypto.randomUUID(),
                    conversationId: conversationIdRef.current!,
                    role: 'assistant',
                    content: '',
                    createdAt: new Date().toISOString(),
                    clarificationRequest: { id: clarificationId, questions, status: 'pending' } as ClarificationRequest,
                };
                return old ? { data: [...old.data, msg] } : { data: [msg] };
            });
        }, [queryClient]),
```

Add `sendClarificationAnswer` to the hook's return object (after line 224, `sendMessage, sendApproval, cancel, isStreaming, isRetrying,`):
```ts
        sendMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying,
```

- [ ] **Step 3: Render `ClarificationCard` and mark answered questions in `MessageItem.tsx`**

In `apps/web/components/platform/chat/MessageItem.tsx`, add the import (after line 11, `import { ApprovalCard } from "./ApprovalCard";`):
```tsx
import { ClarificationCard } from "./ClarificationCard";
```

Add a new prop to `MessageItemProps` (after `onDismiss?: ...`, line 24):
```ts
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }) => void;
```
and destructure it in the function signature (after `onDismiss,` line 36):
```ts
    onClarificationAnswer,
```

Replace the dead-code approval block (line 184, `{false && message.approvalRequest && (`) — leave `ApprovalCard` as-is (out of scope to re-enable it here; it's a separate existing feature), and add the clarification render right after it (after the `ApprovalCard` block's closing `)}` at line 190):
```tsx
                {message.clarificationRequest && (
                    <ClarificationCard
                        request={message.clarificationRequest}
                        onAnswer={(answer) => onClarificationAnswer?.(
                            message.id,
                            message.clarificationRequest!.id,
                            answer.questionIndex,
                            { selectedIndex: answer.selectedIndex, freeText: answer.freeText, skipped: answer.skipped },
                        )}
                    />
                )}
```

- [ ] **Step 4: Thread the handler through `MessageThread.tsx`**

In `apps/web/components/platform/chat/MessageThread.tsx`, add the prop to `MessageThreadProps` (after `onDismiss?: ...`):
```ts
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }) => void;
```
destructure it in the component signature, and pass it through to `<MessageItem .../>` alongside the existing `onApprove`/`onDismiss` props:
```tsx
                            onClarificationAnswer={onClarificationAnswer}
```

- [ ] **Step 5: Wire from the chat page**

Find where `<MessageThread .../>` is rendered (in `apps/web/app/[tenant]/dashboard/chat/page.tsx` or `useChatPage.ts` — grep for `onApprove=` to find the exact call site) and add:
```tsx
                onClarificationAnswer={(messageId, clarificationId, questionIndex, answer) => {
                    sendClarificationAnswer(clarificationId, questionIndex, answer);
                    // Mark the request answered in local cache once all questions are done —
                    // the message stays visible with its selections; status flips server-side
                    // is not tracked further since the agent's next turn supersedes it.
                }}
```
alongside the existing `onApprove`/`onDismiss` props already passed there, using the same `sendClarificationAnswer` obtained from `useChatStream`'s return value (Step 2).

- [ ] **Step 6: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit -p .`
Expected: no new errors across `useChat.ts`, `useChatStream.ts`, `MessageThread.tsx`, `MessageItem.tsx`.

- [ ] **Step 7: Manual end-to-end verification**

Restart `agent-orchestrator` locally (`pm2 restart agent-orchestrator --update-env` or `pnpm dev` per the repo's local-dev instructions), open a chat conversation, and send a message engineered to be ambiguous (e.g. one the platform prompt would reasonably route into calling `ask_clarifying_questions` — this depends on the live prompt in `agent_templates`, so if it doesn't trigger naturally, temporarily call the tool directly via a test harness). Confirm: `ClarificationCard` renders with pagination, selecting an option and clicking `Continue`/`Submit` calls the new `/api/chat/clarification` endpoint, and the orchestrator's `ask_clarifying_questions` tool resolves with the collected answers.

- [ ] **Step 8: Commit**

```bash
git add apps/web/hooks/useChat.ts apps/web/app/[tenant]/dashboard/chat/useChatStream.ts apps/web/components/platform/chat/MessageThread.tsx apps/web/components/platform/chat/MessageItem.tsx apps/web/app/[tenant]/dashboard/chat/page.tsx
git commit -m "feat(web): wire clarification_request SSE event end-to-end into chat UI"
```

---

## Self-Review Notes

- **Spec coverage:** Design tokens (Task 1) ✓; message-thread collapse/active-state/nested-truncation (Task 2) ✓; theme-aware bubbles + user truncation (Task 3) ✓; pill input, scroll-to-bottom, `Use employee`, disclaimer (Task 4) ✓; `/` and `@` palettes (Task 5) ✓; clarification wizard UI + types (Task 6) ✓; clarification backend plumbing (Task 7) ✓; clarification tool (Task 8) ✓; end-to-end wiring (Task 9) ✓. The one item the spec explicitly deferred (above-input suggestion dropdown) has no task here, matching the spec's decision.
- **Out of scope reminder:** `ApprovalCard`'s dead-code render path (`{false && message.approvalRequest}` in `MessageItem.tsx`) is left disabled — re-enabling it was never in the spec and is a separate decision the user hasn't made.
- **Type consistency:** `ClarificationRequest`/`ClarificationQuestion`/`ClarificationOption` (Task 6) are the single source of truth reused verbatim by the tool's `execute` return shape (Task 8), the SSE payload (Task 7/9), and `ClarificationCard`'s props — no divergent shapes introduced.
