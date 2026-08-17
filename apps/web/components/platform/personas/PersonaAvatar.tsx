"use client";

import { Bot, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonaSummary } from "./types";
import type { PersonaAnimationState } from "./usePersonaAnimationState";

interface PersonaAvatarProps {
    persona?: PersonaSummary | null;
    state?: PersonaAnimationState;
    size?: number;
    className?: string;
    iconClassName?: string;
    /** Overrides the generic Bot fallback icon — e.g. a role-specific icon
     * so agents remain visually distinguishable in a list without color. */
    icon?: LucideIcon;
}

export function PersonaAvatar({ persona, state = "idle", size = 40, className, iconClassName, icon: Icon = Bot }: PersonaAvatarProps) {
    const asset = persona?.animationStates?.[state] ?? persona?.animationStates?.idle;

    if (!asset) {
        return (
            <div
                className={cn("flex shrink-0 items-center justify-center rounded-xl border border-border/50 bg-secondary text-muted-foreground", className)}
                style={{ width: size, height: size }}
            >
                <Icon className={cn("h-1/2 w-1/2", iconClassName)} />
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
