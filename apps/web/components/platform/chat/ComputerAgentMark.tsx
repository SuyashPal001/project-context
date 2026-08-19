import { Monitor } from "lucide-react";

// Per-row mark for every assistant reply after the first (which gets the
// full AgentOrb instead) — a small monitor icon whose screen blinks
// periodically, echoing the orb's own eye-blink so the two marks read as
// "the same agent," just in two different forms: the orb when it first
// shows up, this quiet computer mark for the rest of its replies. Reuses
// lucide's Monitor icon (already a dependency in this file's caller) for the
// frame instead of hand-drawn SVG paths for the same body+stand shape.
export function ComputerAgentMark({ size = 24 }: { size?: number }) {
    const iconSize = size * 0.62;
    return (
        <div
            className="relative shrink-0 rounded-lg bg-muted border border-border/60 flex items-center justify-center text-foreground/70"
            style={{ width: size, height: size }}
        >
            <Monitor width={iconSize} height={iconSize} strokeWidth={1.8} />
            {/* the agent "inside" the screen — Monitor's screen rect spans
                roughly x:2-22, y:3-17 in its 24x24 viewBox, so 50%/42% lands
                centered inside it regardless of iconSize. Positioning
                (translate) and the blink animation (scaleY) both need
                `transform`, so they're split across two nested elements —
                one CSS animation would otherwise clobber the other's
                transform outright instead of composing with it. */}
            <span
                aria-hidden
                className="absolute"
                style={{ left: '50%', top: '42%', transform: 'translate(-50%, -50%)' }}
            >
                <span
                    className="block rounded-full bg-current animate-computer-blink"
                    style={{ width: Math.max(2, iconSize * 0.14), height: Math.max(2, iconSize * 0.14) }}
                />
            </span>
        </div>
    );
}
