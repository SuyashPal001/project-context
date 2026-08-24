"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogTitle className="sr-only">{skill?.name ?? "Skill details"}</DialogTitle>
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
            </DialogContent>
        </Dialog>
    );
}
