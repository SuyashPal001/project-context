import { Download, FileText, Package, Plus, Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/platform/canvas/MarkdownViewer";
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
    skill, isOwner, files, onInstall, onUninstall, onPublish, onTest, isTesting,
}: {
    skill: Skill;
    isOwner: boolean;
    files: SkillFile[];
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
    onTest: () => void;
    isTesting: boolean;
}) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);
    const visibilityStatus = skillVisibilityStatus(skill);

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <SkillIcon seed={skill.id} className="h-14 w-14 rounded-lg border border-border shrink-0" />
                        <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-2">
                                <h1 className="text-2xl font-bold tracking-tight text-foreground truncate">{skill.name}</h1>
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
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                    <p className="text-sm font-medium text-destructive mb-1">Import failed</p>
                    <p className="text-sm text-destructive/90">{skill.failureReason}</p>
                </div>
            )}

            <Tabs defaultValue="skill-md">
                <TabsList className="w-fit gap-1 rounded-full bg-muted p-1">
                    <TabsTrigger
                        value="skill-md"
                        className="rounded-full px-4 py-1.5 text-sm font-medium data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none"
                    >
                        SKILL.md
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="skill-md" className="pt-4">
                    <SkillOverview skill={skill} files={files} />
                </TabsContent>
            </Tabs>

            <div className="flex items-center justify-end gap-2">
                {isOwner && skill.visibility === "private" && hasReadyVersion && (
                    <Button variant="ghost" onClick={onPublish}>Publish</Button>
                )}
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
    );
}

function SkillOverview({ skill, files }: { skill: Skill; files: SkillFile[] }) {
    // Older/still-importing skills have no stored SKILL.md body yet. Version info is
    // already shown as a badge in the header, so there's nothing else to render here.
    if (!skill.body) {
        return null;
    }

    return (
        <div className="grid gap-4 md:grid-cols-[1fr_240px]">
            <div className="min-w-0 space-y-2">
                <h4 className="text-sm font-semibold text-foreground">Skill overview</h4>
                <div
                    className={cn(
                        "max-h-[480px] overflow-y-auto rounded-xl border border-border bg-muted/30 p-6",
                        "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mb-4 [&_h1]:mt-0",
                        "[&_h2]:text-base [&_h2]:font-bold [&_h2]:mb-2 [&_h2]:mt-6",
                        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1.5 [&_h3]:mt-4",
                        "[&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground",
                        "[&_li]:text-sm [&_li]:text-muted-foreground"
                    )}
                >
                    <MarkdownViewer content={skill.body} />
                </div>
            </div>

            <div className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm font-medium text-foreground">
                    <Sparkles className="h-4 w-4" />
                    Skill overview
                </div>
                <div className="mt-3 space-y-1.5">
                    <h5 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Files</h5>
                    {files.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No files</p>
                    ) : (
                        files.map((file) => (
                            <div key={file.fileName} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground">
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate" title={file.fileName}>{file.fileName}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
