import { Download, Package, Plus, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillFilesPanel } from "./SkillFilesPanel";
import { SkillIcon } from "./SkillIcon";
import { skillImportState, skillVisibilityStatus } from "./SkillCard";
import type { Skill, SkillFile } from "./types";

// updatedAt may be absent from an older API deploy — never let a malformed/missing
// timestamp crash the whole modal. Kept compact ("8h ago" not "about 8 hours ago")
// since this sits inline as a one-line summary, not a standalone timestamp.
function relativeTime(value: string | undefined | null): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";

    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
}

export function SkillDetailContent({
    skill, isOwner, files, filesLoading = false, onInstall, onUninstall, onPublish, onTest, isTesting,
}: {
    skill: Skill;
    isOwner: boolean;
    files: SkillFile[];
    filesLoading?: boolean;
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
    onTest: () => void;
    isTesting: boolean;
}) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);
    const visibilityStatus = skillVisibilityStatus(skill);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="max-h-[35%] shrink-0 space-y-2 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6 sm:py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <SkillIcon seed={skill.id} className="h-14 w-14 rounded-lg border border-border shrink-0" />
                        <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <h1 className="truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl" title={skill.name}>{skill.name}</h1>
                                {skill.installed && (
                                    <span className="text-sm text-green-600 dark:text-green-500 shrink-0">
                                        {skill.installedVersion !== skill.latestVersion
                                            ? `installed v${skill.installedVersion}`
                                            : "installed"}
                                    </span>
                                )}
                            </div>
                            <p className="text-sm text-muted-foreground truncate">
                                {skill.isOfficial ? "ProjectContext" : skill.ownerName ?? skill.ownerEmail ?? "Unknown"}
                            </p>
                        </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                        {importFailed && <Badge variant="destructive">{dead ? "Failed" : "Update failed"}</Badge>}
                        <Badge variant="outline" className={cn("text-[10px] font-semibold uppercase tracking-wider", visibilityStatus.className)}>
                            {visibilityStatus.label}
                        </Badge>
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    {skill.updatedAt && skill.updatedAt !== skill.createdAt
                        ? `Created ${relativeTime(skill.createdAt)} · Updated ${relativeTime(skill.updatedAt)}`
                        : `Created ${relativeTime(skill.createdAt)}`}
                </p>

                <p className="text-muted-foreground line-clamp-2">{skill.description ?? "No description"}</p>

                <div className="flex flex-wrap items-center gap-1.5">
                    {hasReadyVersion && (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Package className="h-4 w-4" />
                            v{skill.latestVersion}
                        </span>
                    )}
                    <span className="flex items-center gap-1 text-sm text-muted-foreground" title="Total installs across all tenants">
                        <Download className="h-4 w-4" />
                        {skill.downloadCount}
                    </span>
                    <span className="flex items-center gap-1 text-sm text-muted-foreground" title="Runs for your tenant">
                        <Zap className="h-4 w-4" />
                        {skill.runCount}
                    </span>
                </div>
            </div>

            {importFailed && skill.failureReason && (
                <div className="mx-4 mb-3 max-h-24 shrink-0 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 sm:mx-6">
                    <p className="text-sm font-medium text-destructive mb-1">Import failed</p>
                    <p className="text-sm text-destructive/90">{skill.failureReason}</p>
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 sm:px-6">
                <SkillOverview skill={skill} files={files} filesLoading={filesLoading} />
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-4 sm:pb-4">
                {isOwner && skill.visibility === "private" && hasReadyVersion ? (
                    <Button variant="ghost" onClick={onPublish}>Publish</Button>
                ) : <span />}
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    {skill.installed ? (
                        <>
                            <Button variant="outline" onClick={onUninstall}>Uninstall</Button>
                            <Button onClick={onTest} disabled={isTesting}>
                                {isTesting ? "Opening chat…" : "Test in chat"}
                            </Button>
                        </>
                    ) : dead ? null : (
                        <Button onClick={onInstall} disabled={importing}>
                            <Plus className="h-4 w-4" />
                            {importing ? "Importing…" : "Install skill"}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

function SkillOverview({ skill, files, filesLoading }: { skill: Skill; files: SkillFile[]; filesLoading: boolean }) {
    // Older/still-importing skills have no stored SKILL.md body yet — the
    // header's "Importing"/"Failed" badge already explains why, but leaving
    // this area fully blank still reads as broken rather than pending.
    if (!skill.body) {
        return <p className="text-sm text-muted-foreground">This skill&apos;s content isn&apos;t ready yet.</p>;
    }

    return <SkillFilesPanel skill={skill} files={files} filesLoading={filesLoading} />;
}
