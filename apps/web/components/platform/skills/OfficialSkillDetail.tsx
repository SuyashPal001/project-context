"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { useQueryClient } from "@tanstack/react-query";
import { VisuallyHidden } from "radix-ui";
import { ArrowUpRight, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { startOfficialSkill } from "./startOfficialSkill";
import type { Skill } from "./types";

interface OfficialSkillDetailProps {
    skill: Skill | null;
    onOpenChange: (open: boolean) => void;
}

/**
 * Detail view for an Official skill: a media pane on the left (the example
 * image, sharp and centered, over a blurred copy of itself filling the pane
 * so there are no empty gaps regardless of aspect ratio) and name/description/
 * Best-for/Start on the right. Unlike SkillDetailModal, this never fetches —
 * the caller already has the full Skill (with showcase) from the list query,
 * and there's no install/uninstall/publish/test-in-chat/files panel here at
 * all, only Start.
 *
 * Renders DialogContent directly instead of ModalShell: ModalShell's shared
 * chrome bakes in a "Skill Details" muted-label header bar, which this design
 * (no header at all — the name sits in the content pane) doesn't use.
 */
export function OfficialSkillDetail({ skill, onOpenChange }: OfficialSkillDetailProps) {
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const queryClient = useQueryClient();
    const [isStarting, setIsStarting] = useState(false);

    const handleStart = async () => {
        if (!skill) return;
        setIsStarting(true);
        try {
            await startOfficialSkill(skill, tenantSlug, router, queryClient);
        } finally {
            setIsStarting(false);
        }
    };

    const bestFor = skill?.showcase?.bestFor ?? [];

    return (
        <Dialog open={skill !== null} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="flex h-[90vh] w-[90vw] max-w-[1100px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[75vh] sm:flex-row"
            >
                {skill && (
                    <>
                        {/* Screen-reader-only title — the visible layout has no header bar. */}
                        <VisuallyHidden.Root>
                            <DialogTitle>{skill.name}</DialogTitle>
                        </VisuallyHidden.Root>

                        <div className="relative h-[40vh] w-full shrink-0 overflow-hidden bg-black sm:h-full sm:w-1/2">
                            {skill.showcase?.imageUrl && (
                                <>
                                    <Image
                                        src={skill.showcase.imageUrl}
                                        alt=""
                                        aria-hidden="true"
                                        fill
                                        className="scale-110 object-cover opacity-60 blur-2xl"
                                    />
                                    <div className="absolute inset-0 bg-black/20" />
                                    <Image
                                        src={skill.showcase.imageUrl}
                                        alt={skill.name}
                                        fill
                                        className="relative object-contain"
                                    />
                                </>
                            )}
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col p-10 sm:w-1/2">
                            <div className="flex items-start justify-between gap-4">
                                <h1 className="text-4xl font-bold tracking-tight text-foreground">{skill.name}</h1>
                                <DialogClose
                                    aria-label="Close"
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                >
                                    <X className="h-4 w-4" />
                                </DialogClose>
                            </div>

                            <div className="mt-6 space-y-1.5">
                                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Description</p>
                                <p className="text-lg leading-relaxed text-foreground">
                                    {skill.description ?? "No description"}
                                </p>
                            </div>

                            {bestFor.length > 0 && (
                                <div className="mt-6 space-y-1.5">
                                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Best for</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {bestFor.map((tag) => (
                                            <Badge key={tag} variant="outline" className="rounded-full">
                                                {tag}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="flex-1" />

                            <Button
                                className="w-full bg-black text-white hover:bg-black/90"
                                size="lg"
                                onClick={handleStart}
                                disabled={isStarting}
                            >
                                {isStarting ? (
                                    "Starting…"
                                ) : (
                                    <>
                                        Recreate
                                        <ArrowUpRight className="h-4 w-4" />
                                    </>
                                )}
                            </Button>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
