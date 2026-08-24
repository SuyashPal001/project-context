"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SkillCard } from "@/components/platform/skills/SkillCard";
import { SkillDetailModal } from "@/components/platform/skills/SkillDetailModal";
import { ImportSkillDialog } from "@/components/platform/skills/ImportSkillDialog";
import { installSkill, listSkills } from "@/components/platform/skills/actions";
import type { Skill, SkillTab } from "@/components/platform/skills/types";
import { useTenant } from "@/app/[tenant]/tenant-provider";

export default function SkillsPage() {
    const queryClient = useQueryClient();
    const { tenantId } = useTenant();
    const [tab, setTab] = useState<"mine" | "explore">("mine");
    const [importOpen, setImportOpen] = useState(false);
    const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

    // Poll only while an import is genuinely still running. latestVersion
    // stays at 0 for a *failed* import too, so keying off that alone
    // polled forever on a skill that would never change. The null branch
    // covers the sliver between the skill row and its version row landing.
    const pendingRefetchInterval = (query: { state: { data?: Skill[] } }) => {
        const anyPending = query.state.data?.some(
            (s) => s.latestVersionStatus === "pending" || (s.latestVersionStatus === null && s.latestVersion < 1)
        ) ?? false;
        return anyPending ? 5000 : false;
    };

    const { data: mineList, isLoading: mineLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "mine"],
        queryFn: () => listSkills("mine"),
        enabled: tab === "mine",
        refetchInterval: pendingRefetchInterval,
    });

    const { data: officialList, isLoading: officialLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "official"],
        queryFn: () => listSkills("official"),
        enabled: tab === "explore",
        refetchInterval: pendingRefetchInterval,
    });

    const { data: publicList, isLoading: publicLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "public"],
        queryFn: () => listSkills("public"),
        enabled: tab === "explore",
        refetchInterval: pendingRefetchInterval,
    });

    const mineSkills = mineList ?? [];
    const officialSkills = officialList ?? [];
    const publicSkills = publicList ?? [];

    const handleInstall = async (skillId: string) => {
        try {
            await installSkill(skillId);
            queryClient.invalidateQueries({ queryKey: ["skills"] });
            toast.success("Skill installed.");
        } catch {
            toast.error("Failed to install skill.");
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
                {(["mine", "explore"] as const).map((t) => (
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

            {tab === "mine" ? (
                <SkillGrid
                    skills={mineSkills}
                    isLoading={mineLoading}
                    onSelect={setSelectedSkillId}
                    onInstall={handleInstall}
                    emptyMessage="No skills yet — import one to get started."
                />
            ) : (
                <div className="space-y-8">
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">Official</h2>
                        <SkillGrid
                            skills={officialSkills}
                            isLoading={officialLoading}
                            onSelect={setSelectedSkillId}
                            onInstall={handleInstall}
                            emptyMessage="No official skills yet."
                        />
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">Community</h2>
                        <SkillGrid
                            skills={publicSkills}
                            isLoading={publicLoading}
                            onSelect={setSelectedSkillId}
                            onInstall={handleInstall}
                            emptyMessage="No community skills yet."
                        />
                    </div>
                </div>
            )}

            <ImportSkillDialog
                open={importOpen}
                onOpenChange={setImportOpen}
                onImported={() => queryClient.invalidateQueries({ queryKey: ["skills"] })}
            />

            <SkillDetailModal
                skillId={selectedSkillId}
                tenantId={tenantId}
                onOpenChange={(open) => !open && setSelectedSkillId(null)}
            />
        </div>
    );
}

function SkillGrid({
    skills,
    isLoading,
    onSelect,
    onInstall,
    emptyMessage,
}: {
    skills: Skill[];
    isLoading: boolean;
    onSelect: (skillId: string) => void;
    onInstall: (skillId: string) => void;
    emptyMessage: string;
}) {
    if (isLoading) {
        return (
            <div className="grid gap-4 md:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[140px] w-full rounded-xl" />)}
            </div>
        );
    }

    if (skills.length === 0) {
        return (
            <div className="flex h-[160px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            </div>
        );
    }

    return (
        <div className="grid gap-4 md:grid-cols-2">
            {skills.map((skill) => (
                <SkillCard
                    key={skill.id}
                    skill={skill}
                    onClick={() => onSelect(skill.id)}
                    onInstall={() => onInstall(skill.id)}
                />
            ))}
        </div>
    );
}
