"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { getSkill, installSkill, uninstallSkill, publishSkill } from "./actions";
import { SkillDetailContent } from "./SkillDetailContent";
import type { Skill } from "./types";

interface SkillDetailModalProps {
    skillId: string | null;
    tenantId: string;
    onOpenChange: (open: boolean) => void;
}

export function SkillDetailModal({ skillId, tenantId, onOpenChange }: SkillDetailModalProps) {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(false);

    const { data: skill, isLoading, isError } = useQuery<Skill>({
        queryKey: ["skills", "detail", skillId],
        queryFn: () => getSkill(skillId as string),
        enabled: skillId !== null,
        // Poll only while an import is genuinely still running, same rule as the list.
        refetchInterval: (query) => {
            const s = query.state.data as Skill | undefined;
            const stillPending = s?.latestVersionStatus === "pending" || (s?.latestVersionStatus === null && (s?.latestVersion ?? 0) < 1);
            return stillPending ? 5000 : false;
        },
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ["skills"] });
    };

    const handleInstall = async () => {
        if (!skillId) return;
        try {
            await installSkill(skillId);
            invalidate();
            toast.success("Skill installed.");
        } catch {
            toast.error("Failed to install skill.");
        }
    };

    const handleUninstall = async () => {
        if (!skillId) return;
        try {
            await uninstallSkill(skillId);
            invalidate();
            toast.success("Skill uninstalled.");
        } catch {
            toast.error("Failed to uninstall skill.");
        }
    };

    const handlePublish = async () => {
        if (!skillId) return;
        try {
            await publishSkill(skillId);
            invalidate();
            toast.success("Skill published.");
        } catch {
            toast.error("Failed to publish skill.");
        }
    };

    return (
        <Dialog open={skillId !== null} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className={cn(
                    "flex flex-col gap-0 p-0 overflow-hidden transition-[max-width,max-height]",
                    expanded ? "max-w-4xl max-h-[92vh]" : "max-w-2xl max-h-[85vh]"
                )}
            >
                <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
                    <DialogTitle className="text-sm font-semibold text-muted-foreground">Skill Details</DialogTitle>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setExpanded((v) => !v)}
                            title={expanded ? "Collapse" : "Expand"}
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </button>
                        <DialogClose className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                            <X className="h-3.5 w-3.5" />
                        </DialogClose>
                    </div>
                </div>

                <div className="overflow-y-auto p-6">
                    {isLoading ? (
                        <div className="space-y-4">
                            <Skeleton className="h-9 w-64" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                        </div>
                    ) : isError || !skill ? (
                        <Alert variant="destructive">
                            <AlertTitle>Skill not found</AlertTitle>
                            <AlertDescription>
                                This skill doesn&apos;t exist, or you don&apos;t have access to it.
                            </AlertDescription>
                        </Alert>
                    ) : (
                        <SkillDetailContent
                            skill={skill}
                            isOwner={skill.ownerTenantId === tenantId}
                            onInstall={handleInstall}
                            onUninstall={handleUninstall}
                            onPublish={handlePublish}
                        />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
