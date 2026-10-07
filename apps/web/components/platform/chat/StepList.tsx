'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { ThinkingOrb } from 'thinking-orbs';
import { PixelLoader } from './PixelLoader';
import type { LiveStep } from './types';
import { Branch, FileTile, PendingTile } from './Branch';
import { extractResultFiles, isMediaDelegateTool } from './ToolCallCard';

// The live step list for a long job ("Storyboard ✓ · Video clips ✓ · Voice ◐").
// Pattern after beautiful-ui's TaskRows / ThinkingState "Steps" (MIT, Shane
// Levine): a running row shows its work, a finished one settles to a quiet
// check. Rewritten in our own Tailwind and colours. A running row shows a
// thinking-orbs animation (MIT, Jakub Antalik) for its kind of work — pictures
// morph circle → triangle → square — so the stage never looks like the pixel
// loader on the tool row working under it.

const ORB_FOR_KIND: Record<LiveStep['kind'], 'shaping' | 'working' | 'listening' | 'weaving' | 'composing' | 'solving' | 'connecting'> = {
    image: 'shaping',
    video: 'working',
    voice: 'listening',
    join: 'weaving',
    finish: 'composing',
    check: 'solving',
    cast: 'connecting',
};

export interface StepRow {
    key: string;
    label: string;
    kind: LiveStep['kind'];
    total: number;
    done: number;
    failed: number;
    /** Held on the user's OK. */
    waiting: number;
    /** Cancelled, declined or stopped. */
    skipped: number;
    /** Refused for want of credits. */
    credits: number;
    running: boolean;
    /** Chip beside the label: what the running call makes, else the latest one's. */
    detail?: string;
    /** What the step made so far, in order, hung under the row. */
    files: Array<{ fileId: string; name: string; type: string }>;
}

// Steps whose pictures and clips hang under their row. The finished ad
// (joining, captions, end card…) stays the big card under the reply.
// Every step that makes media hangs it under its row; songs and voice-overs
// showed as loose cards below 'Music' (2026-10-07).
const TILE_STEPS = new Set(['pictures', 'storyboard', 'edits', 'clips', 'casting', 'music', 'voice']);

/** One row per step key, in the order each step first started. */
export function groupSteps(steps: LiveStep[]): StepRow[] {
    const rows = new Map<string, StepRow>();
    for (const s of steps) {
        const row = rows.get(s.key) ?? { key: s.key, label: s.label, kind: s.kind, total: 0, done: 0, failed: 0, waiting: 0, skipped: 0, credits: 0, running: false, files: [] as StepRow['files'] };
        row.total += s.count;
        if (s.state === 'done') row.done += s.count;
        else if (s.state === 'failed') row.failed += s.count;
        else if (s.state === 'waiting') row.waiting += s.count;
        else if (s.state === 'skipped') row.skipped += s.count;
        else if (s.state === 'credits') row.credits += s.count;
        else row.running = true;
        if (s.detail && (s.state === 'running' || s.state === 'waiting' || !row.running)) row.detail = s.detail;
        for (const f of s.files ?? []) if (!row.files.some(x => x.fileId === f.fileId)) row.files.push(f);
        rows.set(s.key, row);
    }
    return [...rows.values()];
}

function rowMeta(row: StepRow): string {
    if (row.running) return row.total > 1 ? `${row.done} of ${row.total}` : '';
    if (row.waiting) return 'waiting for your OK';
    if (row.credits) return 'needs credits';
    if (row.failed) return row.failed === row.total ? (row.key === 'checks' ? 'needs a look' : 'failed') : `${row.failed} of ${row.total} need a look`;
    if (row.skipped) return row.skipped === row.total ? 'skipped' : `${row.done} of ${row.total} · ${row.skipped} skipped`;
    return row.total > 1 ? String(row.total) : '';
}

const amberMark = (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-amber-600 dark:text-amber-400" aria-hidden>
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="7" cy="9.6" r="0.7" fill="currentColor" />
    </svg>
);

// The orbs draw on a canvas, so they take a colour value, not a CSS class:
// read our accent (--shimmer-accent: deep rose in light, pale rose in dark)
// and read it again when the theme changes (2026-10-07: they were grey).
function useAccentInk(): string | undefined {
    const { resolvedTheme } = useTheme();
    const [ink, setInk] = useState<string>();
    useEffect(() => {
        const value = getComputedStyle(document.documentElement).getPropertyValue('--shimmer-accent').trim();
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reads a CSS value only available after paint
        setInk(/^(#|rgb)/.test(value) ? value : undefined);
    }, [resolvedTheme]);
    return ink;
}

function RowIcon({ row, live }: { row: StepRow; live: boolean }) {
    const ink = useAccentInk();
    // Picture edits ripple (the user liked it there, 2026-10-07); every other
    // step keeps its orb, so pictures morph circle → triangle → square.
    if (row.running && live && row.key === 'edits') return <PixelLoader kind="step" label={`${row.label} in progress`} />;
    if (row.running && live) return <ThinkingOrb state={ORB_FOR_KIND[row.kind]} size={20} color={ink} aria-label={`${row.label} in progress`} />;
    if (row.waiting) return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground" aria-label="waiting for your OK">
            <path d="M5 3.5v7M9 3.5v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
    if (row.credits || row.failed) return <span aria-label={row.credits ? 'needs credits' : 'needs a look'}>{amberMark}</span>;
    if (row.skipped && !row.done) return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground/70" aria-label="skipped">
            <path d="M3.5 7h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground" aria-label="done">
            <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function StepList({ steps, live = true }: { steps: LiveStep[]; live?: boolean }) {
    const rows = groupSteps(steps);
    if (rows.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1 py-1 normal-case" data-testid="step-list">
            {rows.map(row => {
                // A file that arrived counts as made even when its step has not said so yet.
                const pending = row.running && live && TILE_STEPS.has(row.key) ? Math.min(6, Math.max(0, row.total - Math.max(row.done, row.files.length) - row.failed - row.skipped - row.credits)) : 0;
                const tiles = TILE_STEPS.has(row.key) ? row.files : [];
                return (
                <li key={row.key} className="flex flex-col min-w-0">
                <div className="flex items-center gap-2 text-sm min-w-0">
                    <span className="h-5 w-5 shrink-0 flex items-center justify-center">
                        <RowIcon row={row} live={live} />
                    </span>
                    {/* A running step reads like a running tool row: plain foreground
                        text with the shimmer passing over it; finished rows are quiet. */}
                    <span className={row.running && live ? 'shimmer-text text-foreground truncate' : row.skipped && !row.done && !row.failed ? 'text-muted-foreground/70 truncate' : 'text-muted-foreground truncate'}>{row.label}</span>
                    {row.detail && <span className="min-w-0 max-w-[50%] truncate font-mono text-xs text-muted-foreground bg-muted/60 rounded-md px-2 py-0.5" data-testid="step-detail-chip">{row.detail}</span>}
                    {rowMeta(row) && <span className={`text-xs tabular-nums shrink-0 ${row.credits && !row.running ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{rowMeta(row)}</span>}
                </div>
                {(tiles.length > 0 || pending > 0) && (
                    <Branch>
                        <div className="flex flex-wrap gap-1.5" data-testid="step-files">
                            {tiles.map(f => <FileTile key={f.fileId} file={f} />)}
                            {Array.from({ length: pending }, (_, i) => <PendingTile key={`p${i}`} kind={row.kind === 'video' ? 'video' : row.key === 'music' || row.key === 'voice' ? 'audio' : 'image'} />)}
                        </div>
                    </Branch>
                )}
                </li>
                );
            })}
        </ul>
    );
}

/** Files that hang under a step row (pictures, edits, clips, casting), in order, once each. */
// Which step row a finished picture or clip belongs to, by the tool that made it.
const STEP_FOR_TOOL: Record<string, string[]> = {
    generate_image: ['pictures', 'storyboard'], generate_images: ['pictures', 'storyboard'],
    edit_image: ['edits'], generate_video: ['clips'], generate_videos: ['clips'],
    roll_avatar_variations: ['casting'], roll_character_variations: ['casting'], roll_tvc_variations: ['casting'],
    generate_song: ['music'], generate_jingle: ['music'], generate_narration: ['voice'],
};

/** Steps with the finished pictures and clips that reached the chat on their
 *  own hung under the step of their kind. The file arrives as its own result,
 *  and the step's done (which carries the same file) sometimes never came, so
 *  the tile stayed empty and the picture showed as a loose card (2026-10-07). */
export function withMediaFiles<T extends { toolName: string; result?: Record<string, unknown> }>(steps: LiveStep[] | undefined, calls: T[]): LiveStep[] {
    if (!steps?.length) return steps ?? [];
    const owned = stepTileFileIds(steps);
    const next = steps.map(s => ({ ...s, files: [...(s.files ?? [])] }));
    for (const c of calls) {
        const keys = STEP_FOR_TOOL[c.toolName.replace(/-/g, '_')];
        if (!keys) continue;
        const step = [...next].reverse().find(s => keys.includes(s.key));
        if (!step) continue;
        for (const f of extractResultFiles(c.toolName, c.result)) {
            if (owned.has(f.fileId)) continue;
            owned.add(f.fileId);
            step.files.push({ fileId: f.fileId, name: f.name, type: f.fileType });
        }
    }
    return next;
}

export function stepTileFiles(steps: LiveStep[]): Array<{ fileId: string; name: string; type: string }> {
    const seen = new Set<string>();
    return steps.filter(s => TILE_STEPS.has(s.key)).flatMap(s => s.files ?? []).filter(f => !seen.has(f.fileId) && !!seen.add(f.fileId));
}

export function stepTileFileIds(steps: LiveStep[]): Set<string> {
    return new Set(stepTileFiles(steps).map(f => f.fileId));
}

/** Trace rows minus what the step rows already show: the Director's own row,
 *  and media rows whose files all hang under a step. Unchanged with no steps. */
export function withoutStepOwned<T extends { toolName: string; result?: Record<string, unknown> }>(calls: T[], steps: LiveStep[] | undefined): T[] {
    if (!steps?.length) return calls;
    const owned = stepTileFileIds(steps);
    return calls.filter(c => {
        if (isMediaDelegateTool(c.toolName)) return false;
        const files = extractResultFiles(c.toolName, c.result);
        return !(files.length > 0 && files.every(f => owned.has(f.fileId)));
    });
}
