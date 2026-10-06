'use client';

import { useEffect, useState } from 'react';

// Pixel-grid loader for long media work, one motion per kind: pictures drive
// right, video laps the edge like a reel, audio pulses as dots. Pattern after
// beautiful-ui's LoadingState (MIT, Shane Levine); rewritten in our Tailwind
// with the rose accent. Reduced motion holds the grid still.

const chevron = Array.from({ length: 9 }, (_, i) => (i % 3 + Math.abs(Math.floor(i / 3) - 1)) * 90);
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
    const k = ORBIT_ORDER.indexOf(i);
    return k === -1 ? null : k * 110;
});

export type PixelLoaderKind = 'image' | 'video' | 'audio';

const PATTERNS: Record<PixelLoaderKind, { delays: (number | null)[]; dur: number; round: boolean }> = {
    image: { delays: chevron, dur: 650, round: false },
    video: { delays: orbit, dur: 950, round: false },
    audio: { delays: chevron, dur: 650, round: true },
};

export function PixelLoader({ kind, label }: { kind: PixelLoaderKind; label?: string }) {
    const { delays, dur, round } = PATTERNS[kind];
    return (
        <span role="status" aria-label={label ?? 'working'} className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]" data-testid="pixel-loader" data-kind={kind}>
            {delays.map((delay, i) => (
                <span
                    key={i}
                    className={`size-[4px] bg-[var(--shimmer-accent)] motion-reduce:!animate-none ${round ? 'rounded-full' : 'rounded-[1px]'}`}
                    style={{
                        opacity: delay === null ? 0.1 : 0.2,
                        animation: delay === null ? 'none' : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
                    }}
                />
            ))}
        </span>
    );
}

/** "8.2s", "1m 8.2s" since mount. */
export function useElapsedLabel(active: boolean): string {
    const [ds, setDs] = useState(0);
    useEffect(() => {
        if (!active) return;
        const t = setInterval(() => setDs(d => d + 1), 100);
        return () => clearInterval(t);
    }, [active]);
    const total = ds / 10;
    return total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}
