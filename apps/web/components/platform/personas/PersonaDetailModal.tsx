"use client";

import { Pin } from "lucide-react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PersonaAvatar } from "./PersonaAvatar";
import type { PersonaDetail } from "./types";
import { hirePersona } from "./actions";

interface PersonaDetailModalProps {
    persona: PersonaDetail | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAssign?: (personaId: string) => void;
    onFire?: (personaId: string) => void;
    isHired?: boolean;
}

export function PersonaDetailModal({ persona, open, onOpenChange, onAssign, onFire, isHired }: PersonaDetailModalProps) {
    if (!persona) return null;

    const handleAssign = async () => {
        if (onAssign) return onAssign(persona.id);
        await hirePersona(persona);
        onOpenChange(false);
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

                {persona.exampleAssetUrl && (
                    <div className="space-y-1.5">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={persona.exampleAssetUrl} alt={persona.exampleCaption ?? persona.name} className="w-full rounded-lg border border-border" />
                        {persona.exampleCaption && (
                            <p className="text-xs text-muted-foreground">{persona.exampleCaption}</p>
                        )}
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                    {isHired && (
                        <Button variant="outline" onClick={handleFire}>Fire</Button>
                    )}
                    <Button onClick={handleAssign}>Assign Task Now</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
