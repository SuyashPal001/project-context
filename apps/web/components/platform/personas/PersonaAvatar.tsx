"use client";

import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonaSummary } from "./types";
import type { PersonaAnimationState } from "./usePersonaAnimationState";

interface PersonaAvatarProps {
    persona?: PersonaSummary | null;
    state?: PersonaAnimationState;
    size?: number;
    className?: string;
    iconClassName?: string;
}

// Deterministic stand-in color per agent, used only while no persona
// illustration exists yet — distinguishes agents at a glance in a list
// instead of every un-arted agent rendering as the same plain gray box.
const FALLBACK_HUES = [
    "bg-rose-500/20 text-rose-600 dark:text-rose-400",
    "bg-amber-500/20 text-amber-600 dark:text-amber-400",
    "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
    "bg-sky-500/20 text-sky-600 dark:text-sky-400",
    "bg-violet-500/20 text-violet-600 dark:text-violet-400",
    "bg-pink-500/20 text-pink-600 dark:text-pink-400",
];

function fallbackHue(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length];
}

export function PersonaAvatar({ persona, state = "idle", size = 40, className, iconClassName }: PersonaAvatarProps) {
    const asset = persona?.animationStates?.[state] ?? persona?.animationStates?.idle;

    if (!asset) {
        return (
            <div
                className={cn("flex shrink-0 items-center justify-center rounded-xl border border-border/50", fallbackHue(persona?.name ?? persona?.id ?? "agent"), className)}
                style={{ width: size, height: size }}
            >
                <Bot className={cn("h-1/2 w-1/2", iconClassName)} />
            </div>
        );
    }

    return (
        // eslint-disable-next-line @next/next/no-img-element -- persona assets are user/ops-uploaded URLs, not static build assets
        <img
            src={asset}
            alt={persona?.name ?? "Agent"}
            width={size}
            height={size}
            className={cn("shrink-0 rounded-xl object-cover border border-border/50", className)}
        />
    );
}
