"use client";

import { Bot, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonaSummary } from "./types";
import type { PersonaAnimationState } from "./usePersonaAnimationState";

interface PersonaAvatarProps {
    persona?: PersonaSummary | null;
    /** A custom agent avatar (agents.avatarUrl) — takes priority over the persona
     * asset when both exist, since it's the more specific, user-chosen identity. */
    avatarUrl?: string | null;
    state?: PersonaAnimationState;
    size?: number;
    className?: string;
    iconClassName?: string;
    /** Overrides the generic Bot fallback icon — e.g. a role-specific icon
     * so agents remain visually distinguishable in a list without color. */
    icon?: LucideIcon;
}

export function PersonaAvatar({ persona, avatarUrl, state, size = 40, className, iconClassName, icon: Icon = Bot }: PersonaAvatarProps) {
    const asset = avatarUrl ?? persona?.animationStates?.[state ?? "idle"] ?? persona?.animationStates?.idle;

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
        // Motion only fires where a caller passes a live `state` (an open chat
        // stream) — `data-persona-state` is omitted entirely otherwise, so no
        // CSS animation selector matches and the avatar stays static in the
        // sidebar list, title, pickers, and cards. Where it does fire, it
        // reacts to whatever image is showing — custom avatar or persona
        // still — so it doesn't depend on whether a persona is assigned.
        <div
            data-persona-state={state}
            className="persona-avatar-motion shrink-0"
            style={{ width: size, height: size }}
        >
            {/* eslint-disable-next-line @next/next/no-img-element -- persona assets are user/ops-uploaded URLs, not static build assets */}
            <img
                src={asset}
                alt={persona?.name ?? "Agent"}
                width={size}
                height={size}
                className={cn("h-full w-full rounded-xl object-cover border border-border/50", className)}
            />
        </div>
    );
}
