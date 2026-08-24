"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { attachSkillToAgent, listSkills } from "./actions";
import type { Skill } from "./types";

interface AttachSkillPickerProps {
    agentId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAttached: () => void;
}

export function AttachSkillPicker({ agentId, open, onOpenChange, onAttached }: AttachSkillPickerProps) {
    const [attachingId, setAttachingId] = useState<string | null>(null);

    // "installed" — not "mine". `mine` filters on ownerTenantId, so a skill
    // this tenant installed from the Public or Official tab (owned by someone
    // else) never appears there. `installed` is the tenant's actual install
    // library: every skill with an active skill_installs row, whoever owns it.
    const { data: skillsList, isLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "installed"],
        queryFn: () => listSkills("installed"),
        enabled: open,
    });

    const installed = (skillsList ?? []).filter((s) => s.installed);

    const handleAttach = async (skill: Skill) => {
        setAttachingId(skill.id);
        try {
            // installId is skill_installs.id — the row agentSkills.installId is an
            // FK to. skill.id is a different row entirely. The server reads the real
            // SKILL.md body off that install's pinned version, so nothing about the
            // skill content is sent from here.
            await attachSkillToAgent(agentId, skill);
            toast.success(`${skill.name} attached.`);
            onAttached();
            onOpenChange(false);
        } catch (err) {
            if (err instanceof Error && err.message === "NO_INSTALL_ID") {
                toast.error("This skill has no install record — reinstall it from the Skills page first.");
            } else {
                toast.error("Failed to attach skill.");
            }
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
