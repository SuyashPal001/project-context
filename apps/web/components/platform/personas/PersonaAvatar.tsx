"use client";

import { useMemo } from "react";
import { Bot, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildAvatarSvg } from "@/components/platform/agents/avatar-builder/buildAvatarSvg";
import { randomizeAvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";
import type { PersonaSummary } from "./types";
import type { PersonaAnimationState } from "./usePersonaAnimationState";

// Deterministic string -> PRNG (xmur3 + mulberry32), so the same persona
// always rolls the same generated face instead of a new one every render.
function seededRng(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return () => {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    };
}

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
    // Motion (via `state` below) is fully decoupled from persona art — see
    // globals.css's persona-avatar-motion rules — so there's no per-state image to
    // look up. Personas have no dedicated avatar field (only avatarUrl on a
    // hired agent) — exampleAssetUrl used to fill in as a stand-in avatar for
    // persona-template browsing (Explore), but that field is a portfolio
    // outcome screenshot, not a face; once real outcome art replaced the
    // placeholders it rendered as a cropped scene fragment instead of an
    // icon. Falls through to the generic Icon tile until personas get a real
    // avatar field.
    const asset = avatarUrl ?? undefined;

    // No uploaded image at all: for a persona, generate the same deterministic
    // cartoon face every time (seeded off persona.id) via the avatar builder's
    // own SVG generator — real art, not a random reroll, without needing any
    // upload/backend field. Only falls all the way through to the bare Icon
    // tile when there's no persona to seed from either.
    const generatedSvg = useMemo(() => {
        if (asset || !persona) return null;
        return buildAvatarSvg(randomizeAvatarParams(seededRng(persona.id)));
    }, [asset, persona]);

    if (!asset && generatedSvg) {
        return (
            <div
                className={cn("shrink-0 rounded-xl overflow-hidden border border-border/50 bg-secondary [&>svg]:h-full [&>svg]:w-full", className)}
                style={{ width: size, height: size }}
                // buildAvatarSvg only ever interpolates AvatarParams' closed enum
                // values and hex color strings — never free text — so this is not
                // an injection surface. See avatar-builder's design spec.
                dangerouslySetInnerHTML={{ __html: generatedSvg }}
            />
        );
    }

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
