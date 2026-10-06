'use client';

import { PixelLoader, type PixelLoaderKind } from './PixelLoader';
import type { LiveStep } from './types';

// The live step list for a long job ("Storyboard ✓ · Video clips ✓ · Voice ◐").
// Pattern after beautiful-ui's TaskRows / ThinkingState "Steps" (MIT, Shane
// Levine): a running row shows its work, a finished one settles to a quiet
// check. Rewritten in our own Tailwind and colours. A running row shows the
// same rose pixel loader as the tool rows, one motion per kind of media.

const LOADER_FOR_KIND: Record<LiveStep['kind'], PixelLoaderKind> = {
    image: 'image',
    cast: 'image',
    video: 'video',
    join: 'video',
    finish: 'video',
    check: 'video',
    voice: 'audio',
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
}

/** One row per step key, in the order each step first started. */
export function groupSteps(steps: LiveStep[]): StepRow[] {
    const rows = new Map<string, StepRow>();
    for (const s of steps) {
        const row = rows.get(s.key) ?? { key: s.key, label: s.label, kind: s.kind, total: 0, done: 0, failed: 0, waiting: 0, skipped: 0, credits: 0, running: false };
        row.total += s.count;
        if (s.state === 'done') row.done += s.count;
        else if (s.state === 'failed') row.failed += s.count;
        else if (s.state === 'waiting') row.waiting += s.count;
        else if (s.state === 'skipped') row.skipped += s.count;
        else if (s.state === 'credits') row.credits += s.count;
        else row.running = true;
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

function RowIcon({ row, live }: { row: StepRow; live: boolean }) {
    if (row.running && live) return <PixelLoader kind={LOADER_FOR_KIND[row.kind]} label={`${row.label} in progress`} />;
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
            {rows.map(row => (
                <li key={row.key} className="flex items-center gap-2 text-sm min-w-0">
                    <span className="h-5 w-5 shrink-0 flex items-center justify-center">
                        <RowIcon row={row} live={live} />
                    </span>
                    {/* A running step reads like a running tool row: plain foreground
                        text with the shimmer passing over it; finished rows are quiet. */}
                    <span className={row.running && live ? 'shimmer-text text-foreground truncate' : row.skipped && !row.done && !row.failed ? 'text-muted-foreground/70 truncate' : 'text-muted-foreground truncate'}>{row.label}</span>
                    {rowMeta(row) && <span className={`text-xs tabular-nums shrink-0 ${row.credits && !row.running ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{rowMeta(row)}</span>}
                </li>
            ))}
        </ul>
    );
}
