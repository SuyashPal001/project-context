"use client";

import { Pin, Brain } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmployeeCard } from "@/components/platform/shared/EmployeeCard";
import { PersonaAvatar } from "./PersonaAvatar";
import type { PersonaSummary } from "./types";

interface PersonaCardProps {
    persona: PersonaSummary;
    isHired: boolean;
    /** A real, shareable/right-clickable URL to this persona — deep-links the
     * Explore modal open via ?persona=<slug>, same pattern AgentCard uses for
     * the Mine tab's href, instead of a bare onClick with no URL. */
    href: string;
}

export function PersonaCard({ persona, isHired, href }: PersonaCardProps) {
    const outcomes = [
        persona.exampleAssetUrl && { url: persona.exampleAssetUrl, caption: persona.exampleCaption },
        persona.exampleAssetUrl2 && { url: persona.exampleAssetUrl2, caption: persona.exampleCaption2 },
    ].filter((o): o is { url: string; caption: string | null } => Boolean(o));

    return (
        <EmployeeCard
            href={href}
            avatar={<PersonaAvatar persona={persona} size={44} className="rounded-2xl" />}
            name={persona.name}
            headerBadge={
                persona.isOfficial ? (
                    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
                        <Pin className="h-3 w-3" /> Official
                    </Badge>
                ) : undefined
            }
            subtitle={
                persona.defaultModel && (
                    <span className="inline-flex items-center gap-1.5">
                        <Brain className="h-3.5 w-3.5 text-muted-foreground" /> {persona.defaultModel}
                    </span>
                )
            }
            description={<p className="line-clamp-2">{persona.tagline}</p>}
            action={
                isHired ? (
                    <span className="flex items-center gap-1.5 pt-1 text-sm font-bold text-foreground">
                        <span className="h-2.5 w-2.5 rounded-full bg-green-500" /> Hired
                    </span>
                ) : (
                    <span className="rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground">Hire</span>
                )
            }
            skillTags={persona.skillTags}
            outcomes={outcomes}
        />
    );
}
