'use client';

import { ThinkingOrb } from 'thinking-orbs';
import type { LiveStep } from './types';

// The live step list for a long job ("Storyboard ✓ · Video clips ✓ · Voice ◐").
// Pattern after beautiful-ui's TaskRows / ThinkingState "Steps" (MIT, Shane
// Levine): a running row shows its work, a finished one settles to a quiet
// check. Rewritten in our own Tailwind and colours; the orb is the
// thinking-orbs package (MIT, Jakub Antalik), one animation per kind of work.

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
    running: boolean;
}

/** One row per step key, in the order each step first started. */
export function groupSteps(steps: LiveStep[]): StepRow[] {
    const rows = new Map<string, StepRow>();
    for (const s of steps) {
        const row = rows.get(s.key) ?? { key: s.key, label: s.label, kind: s.kind, total: 0, done: 0, failed: 0, running: false };
        row.total += s.count;
        if (s.state === 'done') row.done += s.count;
        else if (s.state === 'failed') row.failed += s.count;
        else row.running = true;
        rows.set(s.key, row);
    }
    return [...rows.values()];
}

function rowMeta(row: StepRow): string {
    if (row.running) return row.total > 1 ? `${row.done} of ${row.total}` : '';
    if (row.failed) return row.failed === row.total ? (row.key === 'checks' ? 'needs a look' : 'failed') : `${row.failed} of ${row.total} need a look`;
    return row.total > 1 ? String(row.total) : '';
}

export function StepList({ steps, live = true }: { steps: LiveStep[]; live?: boolean }) {
    const rows = groupSteps(steps);
    if (rows.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1 py-1 normal-case" data-testid="step-list">
            {rows.map(row => (
                <li key={row.key} className="flex items-center gap-2 text-sm min-w-0">
                    <span className="h-5 w-5 shrink-0 flex items-center justify-center">
                        {row.running && live ? (
                            <ThinkingOrb state={ORB_FOR_KIND[row.kind]} size={20} aria-label={`${row.label} in progress`} />
                        ) : row.failed > 0 ? (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-amber-500" aria-label="needs a look">
                                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" />
                                <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                                <circle cx="7" cy="9.6" r="0.7" fill="currentColor" />
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground" aria-label="done">
                                <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        )}
                    </span>
                    {/* A running step shimmers like the header and "Thinking…": live work
                        reads the same everywhere; finished rows are quiet. */}
                    <span className={row.running && live ? 'shimmer-text text-shimmer-accent-80 truncate' : 'text-muted-foreground truncate'}>{row.label}</span>
                    {rowMeta(row) && <span className="text-xs text-muted-foreground tabular-nums shrink-0">{rowMeta(row)}</span>}
                </li>
            ))}
        </ul>
    );
}
