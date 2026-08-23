"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SkillGrid } from "@/components/platform/skills/SkillGrid";
import { ImportSkillDialog } from "@/components/platform/skills/ImportSkillDialog";
import { listSkills, installSkill, uninstallSkill, publishSkill } from "@/components/platform/skills/actions";
import type { Skill, SkillTab } from "@/components/platform/skills/types";
import { useTenant } from "@/app/[tenant]/tenant-provider";

export default function SkillsPage() {
    const queryClient = useQueryClient();
    const { tenantId } = useTenant();
    const [tab, setTab] = useState<SkillTab>("mine");
    const [importOpen, setImportOpen] = useState(false);

    const { data: skillsList, isLoading } = useQuery<Skill[]>({
        queryKey: ["skills", tab],
        queryFn: () => listSkills(tab),
        // Poll only while an import is genuinely still running. latestVersion
        // stays at 0 for a *failed* import too, so keying off that alone
        // polled forever on a skill that would never change. The null branch
        // covers the sliver between the skill row and its version row landing.
        refetchInterval: (query) => {
            const rows = query.state.data as Skill[] | undefined;
            const anyPending = rows?.some(
                (s) => s.latestVersionStatus === "pending" || (s.latestVersionStatus === null && s.latestVersion < 1)
            ) ?? false;
            return anyPending ? 5000 : false;
        },
    });

    const skills = skillsList ?? [];

    const handleInstall = async (skillId: string) => {
        try {
            await installSkill(skillId);
            queryClient.invalidateQueries({ queryKey: ["skills"] });
            toast.success("Skill installed.");
        } catch {
            toast.error("Failed to install skill.");
        }
    };

    const handleUninstall = async (skillId: string) => {
        try {
            await uninstallSkill(skillId);
            queryClient.invalidateQueries({ queryKey: ["skills"] });
            toast.success("Skill uninstalled.");
        } catch {
            toast.error("Failed to uninstall skill.");
        }
    };

    const handlePublish = async (skillId: string) => {
        try {
            await publishSkill(skillId);
            queryClient.invalidateQueries({ queryKey: ["skills"] });
            toast.success("Skill published.");
        } catch {
            toast.error("Failed to publish skill.");
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Skills</h1>
                    <p className="text-muted-foreground mt-2">Import, install, and share reusable skill packages</p>
                </div>
                <Button onClick={() => setImportOpen(true)}>+ Import skill</Button>
            </div>

            <div className="flex gap-1 rounded-full bg-muted p-1 w-fit">
                {(["mine", "official", "public"] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cn(
                            "rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                            tab === t ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {t}
                    </button>
                ))}
            </div>

            {isLoading ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[160px] w-full rounded-xl" />)}
                </div>
            ) : skills.length > 0 ? (
                <SkillGrid
                    skills={skills}
                    tenantId={tenantId}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                    onPublish={handlePublish}
                />
            ) : (
                <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                    <p className="text-sm text-muted-foreground">
                        {tab === "mine" ? "No skills yet — import one to get started." : `No ${tab} skills yet.`}
                    </p>
                </div>
            )}

            <ImportSkillDialog
                open={importOpen}
                onOpenChange={setImportOpen}
                onImported={() => queryClient.invalidateQueries({ queryKey: ["skills"] })}
            />
        </div>
    );
}
