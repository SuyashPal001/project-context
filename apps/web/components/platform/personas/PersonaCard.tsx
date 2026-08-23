"use client";

import { Pin, Brain } from "lucide-react";
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
            className="cursor-pointer gap-4 overflow-hidden p-5 transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <PersonaAvatar persona={persona} size={44} className="rounded-2xl" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="text-base font-bold text-foreground">{persona.name}</h3>
                            {persona.isOfficial && (
                                <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
                                    <Pin className="h-3 w-3" /> Official
                                </Badge>
                            )}
                            {persona.defaultModel && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                    <Brain className="h-3.5 w-3.5" /> {persona.defaultModel}
                                </span>
                            )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{persona.tagline}</p>
                    </div>
                </div>

                {isHired ? (
                    <span className="flex shrink-0 items-center gap-1.5 pt-1 text-sm font-bold text-foreground">
                        <span className="h-2.5 w-2.5 rounded-full bg-green-500" /> Hired
                    </span>
                ) : (
                    <span className="shrink-0 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground">Hire</span>
                )}
            </div>

            {(persona.skillTags.length > 0 || persona.exampleAssetUrl) && <hr className="border-border" />}

            {persona.skillTags.length > 0 && (
                <div>
                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Skills</span>
                    <div className="flex flex-wrap gap-1.5">
                        {persona.skillTags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>
                        ))}
                    </div>
                </div>
            )}

            {persona.exampleAssetUrl && (
                <div>
                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Outcomes</span>
                    <div className={persona.exampleAssetUrl2 ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
                        <figure className="relative overflow-hidden rounded-lg border border-border">
                            {/* eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset */}
                            <img src={persona.exampleAssetUrl} alt={persona.exampleCaption ?? persona.name} className="aspect-video w-full object-cover" />
                            {persona.exampleCaption && (
                                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-white">
                                    {persona.exampleCaption}
                                </figcaption>
                            )}
                        </figure>
                        {persona.exampleAssetUrl2 && (
                            <figure className="relative overflow-hidden rounded-lg border border-border">
                                {/* eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset */}
                                <img src={persona.exampleAssetUrl2} alt={persona.exampleCaption2 ?? persona.name} className="aspect-video w-full object-cover" />
                                {persona.exampleCaption2 && (
                                    <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-white">
                                        {persona.exampleCaption2}
                                    </figcaption>
                                )}
                            </figure>
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}
