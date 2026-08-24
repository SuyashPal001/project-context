"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SkillCard } from "@/components/platform/skills/SkillCard";
import { ImportSkillDialog } from "@/components/platform/skills/ImportSkillDialog";
import { listSkills } from "@/components/platform/skills/actions";
import type { Skill, SkillTab } from "@/components/platform/skills/types";

export default function SkillsPage() {
    const queryClient = useQueryClient();
    const tenantSlug = useParams().tenant as string;
    const [tab, setTab] = useState<"mine" | "explore">("mine");
    const [importOpen, setImportOpen] = useState(false);

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
                    tenantSlug={tenantSlug}
                    emptyMessage="No skills yet — import one to get started."
                />
            ) : (
                <div className="space-y-8">
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">Official</h2>
                        <SkillGrid
                            skills={officialSkills}
                            isLoading={officialLoading}
                            tenantSlug={tenantSlug}
                            emptyMessage="No official skills yet."
                        />
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">Community</h2>
                        <SkillGrid
                            skills={publicSkills}
                            isLoading={publicLoading}
                            tenantSlug={tenantSlug}
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
        </div>
    );
}

function SkillGrid({
    skills,
    isLoading,
    tenantSlug,
    emptyMessage,
}: {
    skills: Skill[];
    isLoading: boolean;
    tenantSlug: string;
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
                    href={`/${tenantSlug}/dashboard/skills/${skill.id}`}
                />
            ))}
        </div>
    );
}
