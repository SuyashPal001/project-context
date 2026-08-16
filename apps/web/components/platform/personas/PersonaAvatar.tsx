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
}

export function PersonaAvatar({ persona, state = "idle", size = 40, className }: PersonaAvatarProps) {
    const asset = persona?.animationStates?.[state] ?? persona?.animationStates?.idle;

    if (!asset) {
        return (
            <div
                className={cn("flex shrink-0 items-center justify-center rounded-xl bg-muted border border-border/50", className)}
                style={{ width: size, height: size }}
            >
                <Bot className="h-1/2 w-1/2 text-muted-foreground" />
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
