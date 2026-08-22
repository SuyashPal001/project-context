"use client";

import { Pin } from "lucide-react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PersonaAvatar } from "./PersonaAvatar";
import type { PersonaSummary } from "./types";
import { hirePersona } from "./actions";

interface PersonaDetailModalProps {
    persona: PersonaSummary | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onHire?: (personaId: string) => void;
    onAssign?: (personaId: string) => void;
    onFire?: (personaId: string) => void;
    isHired?: boolean;
}

export function PersonaDetailModal({ persona, open, onOpenChange, onHire, onAssign, onFire, isHired }: PersonaDetailModalProps) {
    if (!persona) return null;

    const handleHire = async () => {
        if (onHire) return onHire(persona.id);
        await hirePersona(persona);
        onOpenChange(false);
    };

    const handleAssign = async () => {
        if (onAssign) return onAssign(persona.id);
    };

    const handleFire = async () => {
        if (!isHired) return;
        if (onFire) return onFire(persona.id);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <PersonaAvatar persona={persona} size={64} className="rounded-2xl" />
                        <div>
                            <DialogTitle className="flex items-center gap-2 text-xl">
                                {persona.name}
                            </DialogTitle>
                            {persona.isOfficial && (
                                <Badge variant="outline" className="mt-1 gap-1 text-amber-600 border-amber-300">
                                    <Pin className="h-3 w-3" /> Official
                                </Badge>
                            )}
                        </div>
                    </div>
                </DialogHeader>

                <p className="text-sm text-muted-foreground">{persona.tagline}</p>

                {persona.skillTags.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            <span className="h-px flex-1 bg-border" /> Skills <span className="h-px flex-1 bg-border" />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {persona.skillTags.map((tag) => (
                                <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>
                            ))}
                        </div>
                    </div>
                )}

                {persona.exampleAssetUrl && (
                    <div className={persona.exampleAssetUrl2 ? "grid grid-cols-2 gap-3" : "space-y-1.5"}>
                        <div className="space-y-1.5">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={persona.exampleAssetUrl} alt={persona.exampleCaption ?? persona.name} className="w-full rounded-lg border border-border" />
                            {persona.exampleCaption && (
                                <p className="text-xs text-muted-foreground">{persona.exampleCaption}</p>
                            )}
                        </div>
                        {persona.exampleAssetUrl2 && (
                            <div className="space-y-1.5">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={persona.exampleAssetUrl2} alt={persona.exampleCaption2 ?? persona.name} className="w-full rounded-lg border border-border" />
                                {persona.exampleCaption2 && (
                                    <p className="text-xs text-muted-foreground">{persona.exampleCaption2}</p>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                    {isHired ? (
                        <>
                            <Button variant="outline" onClick={handleFire}>Fire</Button>
                            <Button onClick={handleAssign}>Assign Task Now</Button>
                        </>
                    ) : (
                        <Button onClick={handleHire}>Hire</Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
