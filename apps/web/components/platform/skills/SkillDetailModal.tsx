"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api } from "@/lib/api";
import { getSkill, installSkill, listSkillFiles, publishSkill, startSkillTestChat, uninstallSkill } from "./actions";
import { SkillDetailContent } from "./SkillDetailContent";
import type { Skill, SkillFile } from "./types";
import type { Agent } from "@/components/platform/agents/types";

interface SkillDetailModalProps {
    skillId: string | null;
    tenantId: string;
    onOpenChange: (open: boolean) => void;
}

export function SkillDetailModal({ skillId, tenantId, onOpenChange }: SkillDetailModalProps) {
    const queryClient = useQueryClient();
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const [isTesting, setIsTesting] = useState(false);

    // Same ['agents'] query key the chat page uses, so this shares its cache
    // rather than issuing a second fetch.
    const { data: agentsData } = useQuery<{ data: Agent[] }>({
        queryKey: ["agents"],
        queryFn: () => api.get("/api/v1/agents"),
        enabled: skillId !== null,
    });

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

    // Only fetched once an import has produced a package to list — a pending or
    // failed version has no S3 prefix, so the request would always come back empty.
    const { data: files, isLoading: filesLoading } = useQuery<SkillFile[]>({
        queryKey: ["skills", "files", skillId],
        queryFn: () => listSkillFiles(skillId as string),
        enabled: skillId !== null && skill?.latestVersionStatus === "ready",
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

    const handleTest = async () => {
        if (!skill) return;
        setIsTesting(true);
        try {
            const { conversationId } = await startSkillTestChat(skill, agentsData?.data ?? []);
            onOpenChange(false);
            router.push(`/${tenantSlug}/dashboard/chat?conversationId=${conversationId}`);
        } catch (err) {
            if (err instanceof Error && err.message === "NO_ACTIVE_AGENTS") {
                toast.error("No active agents available. Please create one first.");
            } else if (err instanceof Error && err.message === "NO_INSTALL_ID") {
                toast.error("This skill has no install record — reinstall it from the Skills page first.");
            } else {
                toast.error("Failed to start a test chat.");
            }
        } finally {
            setIsTesting(false);
        }
    };

    return (
        <Dialog open={skillId !== null} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="flex flex-col gap-0 p-0 overflow-hidden max-w-2xl max-h-[85vh]"
            >
                <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
                    <DialogTitle className="text-sm font-semibold text-muted-foreground">Skill Details</DialogTitle>
                    <DialogClose className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                        <X className="h-3.5 w-3.5" />
                    </DialogClose>
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
                            files={files ?? []}
                            filesLoading={filesLoading}
                            onInstall={handleInstall}
                            onUninstall={handleUninstall}
                            onPublish={handlePublish}
                            onTest={handleTest}
                            isTesting={isTesting}
                        />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
