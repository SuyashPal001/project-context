'use client';

import { useEffect, useRef, useState } from "react";
import { Message } from "./types";

interface ChatTimelineNavigatorProps {
    messages: Message[];
}

const TICK_GAP_PX = 2;
// How many neighboring rows on each side of the hovered tick show up in the
// preview cluster — a window, not the whole message list (that was the bug:
// every tick's text stacked into one tall panel regardless of which tick you
// were actually over).
const PREVIEW_WINDOW_RADIUS = 2;
// Opacity falls off with each row of distance from the hovered row: the
// hovered row itself is fully opaque and bold, its neighbors dim progressively.
const FADE_PER_ROW = 0.28;
const MIN_ROW_OPACITY = 0.35;

const ARIA_LABEL_MAX_CHARS = 100;

// Dock-style magnify-on-hover: fixed base width, prominence comes entirely
// from scaleX/opacity written to the DOM every rAF frame (no CSS transition —
// the eased decay toward each bar's target is what gives the spring feel).
const BASE_BAR_WIDTH_PX = 24;
const BAR_HEIGHT_PX = 2;
const REST_SCALE = 0.333;
const MAX_SCALE = 0.5;
const REST_OPACITY = 0.3;
const MAX_OPACITY = 0.42;
// Cursor-to-bar-center distance (px) beyond which a bar is fully at rest.
const FALLOFF_RADIUS_PX = 48;
// Per-frame exponential ease toward target — higher = snappier, lower = floatier.
const EASE_FACTOR = 0.25;
const SETTLE_EPSILON = 0.002;

function summarize(content: string): string {
    const collapsed = content.trim().replace(/\s+/g, ' ');
    return collapsed.length > ARIA_LABEL_MAX_CHARS
        ? collapsed.slice(0, ARIA_LABEL_MAX_CHARS).trimEnd() + '…'
        : collapsed;
}

export function ChatTimelineNavigator({ messages }: ChatTimelineNavigatorProps) {
    // Index of the single tick currently hovered, or null. Each tick owns its
    // own preview box keyed off this — previously a single shared `expanded`
    // boolean gated one combined panel listing every message, so hovering any
    // one tick opened all of them at once, stacked on top of the chat content.
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    // Clicking a tick keeps its preview cluster visible even after the mouse
    // leaves (instead of only ever showing transiently on hover) — pinned
    // until you click the same tick again or click anywhere outside the
    // navigator. Independent of hoveredIndex so a hover elsewhere can still
    // preview a different tick without disturbing the pin.
    const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const userMessages = messages.filter(m => m.role === 'user');
    const userMessageIds = userMessages.map(m => m.id).join(',');

    // Magnify-on-hover: bar prominence is driven by imperative DOM writes on
    // every rAF frame, not React state/CSS transitions — see design notes.
    const tickContainerRef = useRef<HTMLDivElement>(null);
    const barElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
    const containerTopRef = useRef(0);
    const mouseYRef = useRef<number | null>(null);
    const currentScaleRef = useRef<Map<string, number>>(new Map());
    const currentOpacityRef = useRef<Map<string, number>>(new Map());
    const rafRef = useRef<number | null>(null);

    const registerBarEl = (id: string) => (el: HTMLButtonElement | null) => {
        if (el) barElsRef.current.set(id, el);
        else barElsRef.current.delete(id);
    };

    const barCenterY = (index: number) => index * (BAR_HEIGHT_PX + TICK_GAP_PX) + BAR_HEIGHT_PX / 2;

    const stepMagnify = () => {
        rafRef.current = null;
        let stillAnimating = false;

        userMessages.forEach((m, i) => {
            const el = barElsRef.current.get(m.id);
            if (!el) return;

            let targetScale = REST_SCALE;
            let targetOpacity = REST_OPACITY;
            if (mouseYRef.current !== null) {
                const dist = Math.abs(mouseYRef.current - barCenterY(i));
                const falloff = Math.max(0, 1 - dist / FALLOFF_RADIUS_PX);
                targetScale = REST_SCALE + falloff * (MAX_SCALE - REST_SCALE);
                targetOpacity = REST_OPACITY + falloff * (MAX_OPACITY - REST_OPACITY);
            }

            const prevScale = currentScaleRef.current.get(m.id) ?? REST_SCALE;
            const prevOpacity = currentOpacityRef.current.get(m.id) ?? REST_OPACITY;
            const nextScale = prevScale + (targetScale - prevScale) * EASE_FACTOR;
            const nextOpacity = prevOpacity + (targetOpacity - prevOpacity) * EASE_FACTOR;
            currentScaleRef.current.set(m.id, nextScale);
            currentOpacityRef.current.set(m.id, nextOpacity);

            el.style.transform = `translateZ(0) scaleX(${nextScale})`;
            el.style.opacity = String(nextOpacity);

            if (Math.abs(targetScale - nextScale) > SETTLE_EPSILON || Math.abs(targetOpacity - nextOpacity) > SETTLE_EPSILON) {
                stillAnimating = true;
            }
        });

        if (stillAnimating || mouseYRef.current !== null) {
            rafRef.current = requestAnimationFrame(stepMagnify);
        }
    };

    const ensureMagnifyLoop = () => {
        if (rafRef.current === null) rafRef.current = requestAnimationFrame(stepMagnify);
    };

    const handleTickMouseEnter = () => {
        containerTopRef.current = tickContainerRef.current?.getBoundingClientRect().top ?? 0;
    };

    const handleTickMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        mouseYRef.current = e.clientY - containerTopRef.current;
        ensureMagnifyLoop();
    };

    const handleTickMouseLeave = () => {
        mouseYRef.current = null;
        ensureMagnifyLoop();
    };

    useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

    // Clicking a tick pins its preview open — clear the pin on any click
    // outside the navigator's own root (the panel + tick strip), so it
    // doesn't stay stuck open once you've moved on to something else.
    useEffect(() => {
        if (pinnedIndex === null) return;
        const handleOutsideClick = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setPinnedIndex(null);
            }
        };
        document.addEventListener('mousedown', handleOutsideClick);
        return () => document.removeEventListener('mousedown', handleOutsideClick);
    }, [pinnedIndex]);

    // Scroll-spy: highlight whichever user message is currently near the
    // vertical center of the (nested, scrollable) message list. Default root
    // (the layout viewport) is fine here — intersection is computed against
    // the full clip chain regardless of which ancestor actually scrolls, so
    // this doesn't need a ref threaded down from MessageThread's scroll container.
    useEffect(() => {
        if (userMessageIds === '') return;
        const ids = userMessageIds.split(',');
        const elements = ids
            .map(id => document.getElementById(`message-${id}`))
            .filter((el): el is HTMLElement => el !== null);
        if (elements.length === 0) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries.filter(e => e.isIntersecting);
                if (visible.length === 0) return;
                const topMost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
                const id = topMost.target.id.replace(/^message-/, '');
                setActiveId(id);
            },
            { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
        );
        elements.forEach(el => observer.observe(el));
        return () => observer.disconnect();
    }, [userMessageIds]);

    if (userMessages.length === 0) return null;

    const jumpTo = (id: string) => {
        document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // Clicking a tick (or a row in the preview cluster) jumps to that message
    // and pins its cluster open — clicking the already-pinned tick again
    // unpins it. Independent of hover, so the pin survives the mouse leaving.
    const selectTick = (i: number, id: string) => {
        jumpTo(id);
        setPinnedIndex(prev => (prev === i ? null : i));
    };

    // Hover always wins over the pin while it's active, so previewing a
    // different tick doesn't require clicking away from the pinned one first.
    const effectiveIndex = hoveredIndex ?? pinnedIndex;
    const anyActive = effectiveIndex !== null;
    const windowStart = effectiveIndex === null ? 0 : Math.max(0, effectiveIndex - PREVIEW_WINDOW_RADIUS);
    const windowEnd = effectiveIndex === null ? -1 : Math.min(userMessages.length - 1, effectiveIndex + PREVIEW_WINDOW_RADIUS);

    return (
        <div
            ref={rootRef}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-30"
            onMouseLeave={() => setHoveredIndex(null)}
        >
            {/* One shared cluster, not one box per tick and not the whole message
                list — only a small window of rows around whichever tick is active
                (hovered, or pinned via click), the active row itself full-strength
                and its neighbors fading out by distance. */}
            <div
                className={`absolute right-full top-1/2 -translate-y-1/2 mr-2 w-64 rounded-md border border-border bg-popover py-1 shadow-md transition-[opacity,transform] duration-150 ease-out ${
                    anyActive ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 translate-x-1.5 pointer-events-none'
                }`}
            >
                {effectiveIndex !== null && userMessages.slice(windowStart, windowEnd + 1).map((m, offset) => {
                    const i = windowStart + offset;
                    const distance = Math.abs(i - effectiveIndex);
                    const opacity = Math.max(MIN_ROW_OPACITY, 1 - distance * FADE_PER_ROW);
                    const isRowActive = i === effectiveIndex;
                    return (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => selectTick(i, m.id)}
                            onMouseEnter={() => setHoveredIndex(i)}
                            style={{ opacity }}
                            className={`block w-full truncate px-2.5 py-1 text-left text-xs transition-opacity duration-150 hover:bg-accent ${
                                isRowActive ? 'text-foreground font-medium' : 'text-muted-foreground'
                            }`}
                        >
                            {summarize(m.content)}
                        </button>
                    );
                })}
            </div>

            <div
                ref={tickContainerRef}
                className="flex flex-col items-end py-1"
                style={{ gap: TICK_GAP_PX }}
                onMouseEnter={handleTickMouseEnter}
                onMouseMove={handleTickMouseMove}
                onMouseLeave={handleTickMouseLeave}
            >
                {userMessages.map((m, i) => {
                    const isActive = m.id === activeId;
                    const isHovered = effectiveIndex === i;
                    return (
                        <button
                            key={m.id}
                            ref={registerBarEl(m.id)}
                            type="button"
                            onClick={() => selectTick(i, m.id)}
                            onMouseEnter={() => setHoveredIndex(i)}
                            aria-label={summarize(m.content)}
                            title={summarize(m.content)}
                            style={{
                                width: BASE_BAR_WIDTH_PX,
                                // Only height is CSS-transitioned — it's a discrete on/off for
                                // the exact hovered tick, not something the magnify rAF loop
                                // touches. transform/opacity stay untransitioned (0s) since that
                                // loop already applies its own per-frame easing to those; letting
                                // CSS transition them too would double up and lag behind the cursor.
                                height: isHovered ? 4 : BAR_HEIGHT_PX,
                                transformOrigin: 'right',
                                willChange: 'transform',
                                transition: 'height 150ms ease-out',
                                // Initial paint only — the magnify rAF loop (stepMagnify) takes
                                // over with direct el.style writes from the next hover frame on,
                                // so this never reads from the animation refs during render.
                                transform: `translateZ(0) scaleX(${REST_SCALE})`,
                                opacity: REST_OPACITY,
                            }}
                            className={`rounded-sm cursor-pointer ${
                                isActive
                                    ? 'bg-foreground/80'
                                    : anyActive ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'
                            }`}
                        />
                    );
                })}
            </div>
        </div>
    );
}
