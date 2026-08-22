"use client";

import { Pin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PersonaAvatar } from "./PersonaAvatar";
import type { PersonaSummary } from "./types";

interface PersonaCardProps {
    persona: PersonaSummary;
    isHired: boolean;
    onClick: () => void;
}

export function PersonaCard({ persona, isHired, onClick }: PersonaCardProps) {
    return (
        <Card
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
            className="cursor-pointer overflow-hidden p-4 transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <div className="flex items-start justify-between">
                <PersonaAvatar persona={persona} size={56} className="rounded-2xl" />
                {persona.isOfficial && (
                    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
                        <Pin className="h-3 w-3" /> Official
                    </Badge>
                )}
            </div>

            <p className={isHired ? "mt-3 flex items-center gap-1.5 text-sm font-medium text-green-600" : "mt-3 text-sm text-muted-foreground"}>
                {isHired ? (
                    <>
                        <span className="h-1.5 w-1.5 rounded-full bg-green-600" /> Hired
                    </>
                ) : (
                    "[ Up for hire ]"
                )}
            </p>

            <h3 className="mt-1 text-lg font-bold text-foreground">{persona.name}</h3>
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{persona.tagline}</p>

            {persona.exampleAssetUrl && (
                persona.exampleAssetUrl2 ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset */}
                        <img
                            src={persona.exampleAssetUrl}
                            alt={persona.exampleCaption ?? persona.name}
                            className="aspect-video w-full rounded-lg border border-border object-cover"
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset */}
                        <img
                            src={persona.exampleAssetUrl2}
                            alt={persona.exampleCaption2 ?? persona.name}
                            className="aspect-video w-full rounded-lg border border-border object-cover"
                        />
                    </div>
                ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset
                    <img
                        src={persona.exampleAssetUrl}
                        alt={persona.exampleCaption ?? persona.name}
                        className="mt-3 aspect-video w-full rounded-lg border border-border object-cover"
                    />
                )
            )}
        </Card>
    );
}
