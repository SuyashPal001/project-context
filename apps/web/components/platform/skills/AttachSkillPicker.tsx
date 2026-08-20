"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { listSkills } from "./actions";
import type { Skill } from "./types";

interface AttachSkillPickerProps {
    agentId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAttached: () => void;
}

export function AttachSkillPicker({ agentId, open, onOpenChange, onAttached }: AttachSkillPickerProps) {
    const [attachingId, setAttachingId] = useState<string | null>(null);

    // "mine" already includes everything this tenant owns or has installed
    // (GET /skills?tab=mine filters by ownerTenantId, and every installed
    // row — owned or public — carries installed=true via the left join),
    // so this alone covers "the tenant's installed skill library".
    const { data: skillsList, isLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "mine"],
        queryFn: () => listSkills("mine"),
        enabled: open,
    });

    const installed = (skillsList ?? []).filter((s) => s.installed);

    const handleAttach = async (skill: Skill) => {
        setAttachingId(skill.id);
        try {
            await api.post(`/api/v1/agents/${agentId}/skills`, {
                name: skill.name,
                systemPrompt: skill.description ?? skill.name,
                installId: skill.id,
            });
            toast.success(`${skill.name} attached.`);
            onAttached();
            onOpenChange(false);
        } catch {
            toast.error("Failed to attach skill.");
        } finally {
            setAttachingId(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Attach from library</DialogTitle>
                </DialogHeader>

                {isLoading ? (
                    <div className="space-y-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                ) : installed.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No installed skills yet — install one from the Skills page first.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {installed.map((skill) => (
                            <div key={skill.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                                <div>
                                    <p className="text-sm font-medium">{skill.name}</p>
                                    <p className="text-xs text-muted-foreground">v{skill.installedVersion}</p>
                                </div>
                                <Button size="sm" disabled={attachingId === skill.id} onClick={() => handleAttach(skill)}>
                                    {attachingId === skill.id ? "Attaching…" : "Attach"}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
