"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getSkill, installSkill, uninstallSkill, publishSkill } from "@/components/platform/skills/actions";
import { skillImportState } from "@/components/platform/skills/SkillCard";
import type { Skill } from "@/components/platform/skills/types";
import { useTenant } from "@/app/[tenant]/tenant-provider";

export default function SkillDetailPage() {
    const params = useParams();
    const skillId = params.skillId as string;
    const tenantSlug = params.tenant as string;
    const { tenantId } = useTenant();
    const queryClient = useQueryClient();

    const { data: skill, isLoading, isError } = useQuery<Skill>({
        queryKey: ["skills", "detail", skillId],
        queryFn: () => getSkill(skillId),
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
        try {
            await installSkill(skillId);
            invalidate();
            toast.success("Skill installed.");
        } catch {
            toast.error("Failed to install skill.");
        }
    };

    const handleUninstall = async () => {
        try {
            await uninstallSkill(skillId);
            invalidate();
            toast.success("Skill uninstalled.");
        } catch {
            toast.error("Failed to uninstall skill.");
        }
    };

    const handlePublish = async () => {
        try {
            await publishSkill(skillId);
            invalidate();
            toast.success("Skill published.");
        } catch {
            toast.error("Failed to publish skill.");
        }
    };

    return (
        <div className="space-y-6 max-w-2xl">
            <Link
                href={`/${tenantSlug}/dashboard/skills`}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
            >
                <ArrowLeft className="h-4 w-4" />
                Back to Skills
            </Link>

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
    );
}

function SkillDetailContent({
    skill, isOwner, onInstall, onUninstall, onPublish,
}: {
    skill: Skill;
    isOwner: boolean;
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
}) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <div className="flex items-start justify-between gap-4">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">{skill.name}</h1>
                    {hasReadyVersion && (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground shrink-0 mt-1">
                            <Package className="h-4 w-4" />
                            v{skill.latestVersion}
                        </span>
                    )}
                </div>

                <p className="text-muted-foreground">{skill.description ?? "No description"}</p>

                <div className="flex flex-wrap gap-1.5">
                    {importFailed && <Badge variant="destructive">{dead ? "Failed" : "Update failed"}</Badge>}
                    {skill.isOfficial && <Badge variant="secondary">Official</Badge>}
                    <Badge variant="outline">{skill.visibility === "public" ? "Public" : "Private"}</Badge>
                    {skill.installed && (
                        <Badge variant="outline">Installed v{skill.installedVersion}</Badge>
                    )}
                </div>
            </div>

            {importFailed && skill.failureReason && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                    <p className="text-sm font-medium text-destructive mb-1">Import failed</p>
                    <p className="text-sm text-destructive/90">{skill.failureReason}</p>
                </div>
            )}

            <dl className="grid grid-cols-2 gap-y-2 text-sm rounded-lg border border-border bg-muted/10 p-4">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="text-right">{new Date(skill.createdAt).toLocaleDateString()}</dd>
            </dl>

            <div className="flex gap-2">
                {skill.installed ? (
                    <Button variant="outline" onClick={onUninstall}>Uninstall</Button>
                ) : dead ? null : (
                    <Button onClick={onInstall} disabled={importing}>
                        {importing ? "Importing…" : "Install"}
                    </Button>
                )}
                {isOwner && skill.visibility === "private" && hasReadyVersion && (
                    <Button variant="ghost" onClick={onPublish}>Publish</Button>
                )}
            </div>
        </div>
    );
}
