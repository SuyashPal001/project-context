import { cn } from "@/lib/utils";

const BAR_DELAYS = [0, 0.15, 0.3];

interface WavebarMarkProps {
    // Animates only while this specific reply is actively streaming — bars
    // sit at rest (scaleY 0.8, no motion) for already-finished replies, so a
    // long scrollback of past messages doesn't turn into a wall of pulsing
    // icons. The orb (first assistant message only) still owns the
    // "thinking" animation for the turn currently in progress; this is just
    // a quiet per-row mark for the rest.
    animate?: boolean;
    size?: number;
}

export function WavebarMark({ animate = false, size = 24 }: WavebarMarkProps) {
    return (
        <div
            className="shrink-0 rounded-lg flex items-center justify-center"
            style={{ width: size, height: size, backgroundColor: '#D1FE17' }}
        >
            <div className="flex items-center justify-center gap-[2.5px]" style={{ width: size * 0.58, height: size * 0.58 }}>
                {BAR_DELAYS.map(delay => (
                    <span
                        key={delay}
                        className={cn("w-[2.5px] h-full rounded-[1px]", animate && "animate-wavebar")}
                        style={{
                            backgroundColor: '#0a0a0a',
                            transformOrigin: '50% center',
                            transform: animate ? undefined : 'scaleY(0.8)',
                            ['--wavebar-delay' as string]: `${delay}s`,
                        }}
                    />
                ))}
            </div>
        </div>
    );
}
