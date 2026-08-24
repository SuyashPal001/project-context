"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SkillCard, skillImportState } from "@/components/platform/skills/SkillCard";
import { SkillDetailModal } from "@/components/platform/skills/SkillDetailModal";
import { ImportSkillDialog } from "@/components/platform/skills/ImportSkillDialog";
import { installSkill, listSkills } from "@/components/platform/skills/actions";
import type { Skill, SkillTab } from "@/components/platform/skills/types";
import { useTenant } from "@/app/[tenant]/tenant-provider";

// An import stuck "pending" past this is treated the same as a failure —
// the background job either died or will never finish, and there's no
// point leaving it spinning in the UI forever.
const STUCK_IMPORT_MS = 5 * 60 * 1000;

function isStuckImporting(skill: Skill): boolean {
    const { importing } = skillImportState(skill);
    if (!importing) return false;
    const startedAt = new Date(skill.updatedAt ?? skill.createdAt).getTime();
    if (Number.isNaN(startedAt)) return false;
    return Date.now() - startedAt > STUCK_IMPORT_MS;
}

// Hide a skill entirely once its import is dead (failed with no prior
// working version) or has been stuck pending too long — there's no
// retry/delete action yet, so leaving these visible is pure clutter. A
// failed *update* on a skill that still has an earlier ready version stays
// visible, since that version still works.
function isDeadOrStuck(skill: Skill): boolean {
    return skillImportState(skill).dead || isStuckImporting(skill);
}

export default function SkillsPage() {
    const queryClient = useQueryClient();
    const { tenantId } = useTenant();
    const [tab, setTab] = useState<"mine" | "explore">("mine");
    const [importOpen, setImportOpen] = useState(false);
    const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
    // Last known dead/stuck state per skill, so we only toast on a live
    // transition into that state (not for a skill that was already dead
    // before this page load — that one gets silently filtered, no toast).
    // `undefined` means "not seen yet this session" and must never toast.
    const deadStateRef = useRef<Map<string, boolean>>(new Map());

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

    // Notify only on a live transition into dead/stuck — a skill that was
    // already dead before this page loaded gets silently filtered below,
    // no toast, so refreshing the page never re-announces old failures.
    useEffect(() => {
        for (const skill of mineList ?? []) {
            const isDead = isDeadOrStuck(skill);
            const wasDead = deadStateRef.current.get(skill.id);
            deadStateRef.current.set(skill.id, isDead);
            if (!isDead || wasDead !== false) continue;
            const { importFailed } = skillImportState(skill);
            toast.error(
                importFailed
                    ? `"${skill.name}" failed to import — try again in a bit.`
                    : `"${skill.name}" is taking longer than expected to import — try again in a bit.`
            );
        }
    }, [mineList]);

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

    const mineSkills = (mineList ?? []).filter((s) => !isDeadOrStuck(s));
    const officialSkills = (officialList ?? []).filter((s) => !isDeadOrStuck(s));
    const publicSkills = (publicList ?? []).filter((s) => !isDeadOrStuck(s));

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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
