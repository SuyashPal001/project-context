"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ModalShell } from "@/components/platform/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { startOfficialSkill } from "./startOfficialSkill";
import type { Skill } from "./types";

interface OfficialSkillDetailProps {
    skill: Skill | null;
    onOpenChange: (open: boolean) => void;
}

/**
 * Detail view for an Official skill: large example image on the left, name,
 * description, Best-for chips and a full-width Start button on the right.
 * Unlike SkillDetailModal, this never fetches — the caller already has the
 * full Skill (with showcase) from the list query, and there's no
 * install/uninstall/publish/test-in-chat/files panel here at all, only Start.
 */
export function OfficialSkillDetail({ skill, onOpenChange }: OfficialSkillDetailProps) {
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const [isStarting, setIsStarting] = useState(false);

    const handleStart = async () => {
        if (!skill) return;
        setIsStarting(true);
        try {
            await startOfficialSkill(skill, tenantSlug, router);
        } finally {
            setIsStarting(false);
        }
    };

    const bestFor = skill?.showcase?.bestFor ?? [];

    return (
        <ModalShell open={skill !== null} onOpenChange={onOpenChange} title="Skill Details" size="lg">
            {skill && (
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row">
                    <div className="relative aspect-[3/4] w-full shrink-0 sm:h-full sm:w-[380px]">
                        {skill.showcase?.imageUrl && (
                            <Image src={skill.showcase.imageUrl} alt={skill.name} fill className="object-cover" />
                        )}
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 sm:p-8">
                        <div className="space-y-2">
                            <h1 className="text-2xl font-bold tracking-tight text-foreground">{skill.name}</h1>
                            <p className="text-muted-foreground">{skill.description ?? "No description"}</p>
                        </div>

                        {bestFor.length > 0 && (
                            <div className="space-y-1.5">
                                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Best for</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {bestFor.map((tag) => (
                                        <Badge key={tag} variant="outline">{tag}</Badge>
                                    ))}
                                </div>
                            </div>
                        )}

                        <Button className="mt-auto w-full" onClick={handleStart} disabled={isStarting}>
                            {isStarting ? "Starting…" : "Start"}
                        </Button>
                    </div>
                </div>
            )}
        </ModalShell>
    );
}
