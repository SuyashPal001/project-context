import { formatDistanceToNow } from "date-fns";
import { CalendarClock, CalendarPlus, Download, FileText, Package, Plus, Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownViewer } from "@/components/platform/canvas/MarkdownViewer";
import { SkillIcon } from "./SkillIcon";
import { skillImportState } from "./SkillCard";
import type { Skill, SkillFile } from "./types";

// updatedAt may be absent from an older API deploy — never let a malformed/missing
// timestamp crash the whole modal.
function relativeTime(value: string | undefined | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatDistanceToNow(date, { addSuffix: true });
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

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <div className="flex items-center gap-3">
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

                <p className="text-muted-foreground line-clamp-2">{skill.description ?? "No description"}</p>

                <div className="flex flex-wrap items-center gap-1.5">
                    {importFailed && <Badge variant="destructive">{dead ? "Failed" : "Update failed"}</Badge>}
                    {skill.isOfficial && <Badge variant="secondary">Official</Badge>}
                    <Badge variant="outline">{skill.visibility === "public" ? "Community" : "Private"}</Badge>
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

            <SkillOverview skill={skill} files={files} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2">
                    <MetaPill icon={CalendarPlus} label="Created" value={relativeTime(skill.createdAt)} />
                    <MetaPill icon={CalendarClock} label="Last update" value={relativeTime(skill.updatedAt)} />
                </div>

                <div className="flex items-center gap-2">
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
                <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border p-4 text-sm">
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

function MetaPill({ icon: Icon, label, value }: { icon: typeof CalendarClock; label: string; value: string }) {
    return (
        <span
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm text-foreground"
            title={label}
        >
            <Icon className="h-4 w-4 text-muted-foreground" />
            {value}
        </span>
    );
}
