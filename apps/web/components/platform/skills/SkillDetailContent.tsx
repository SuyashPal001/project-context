import { formatDistanceToNow } from "date-fns";
import { CalendarClock, CalendarPlus, FileText, Package, Plus, Sparkles, User, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownViewer } from "@/components/platform/canvas/MarkdownViewer";
import { skillImportState } from "./SkillCard";
import type { Skill } from "./types";

// updatedAt may be absent from an older API deploy — never let a malformed/missing
// timestamp crash the whole modal.
function relativeTime(value: string | undefined | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatDistanceToNow(date, { addSuffix: true });
}

export function SkillDetailContent({
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
                    <div className="min-w-0 space-y-1.5">
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">{skill.name}</h1>
                        <p className="text-muted-foreground line-clamp-2">{skill.description ?? "No description"}</p>
                    </div>

                    <div className="shrink-0">
                        {skill.installed ? (
                            <Button variant="outline" onClick={onUninstall}>Uninstall</Button>
                        ) : dead ? null : (
                            <Button onClick={onInstall} disabled={importing}>
                                <Plus className="h-4 w-4" />
                                {importing ? "Importing…" : "Install skill"}
                            </Button>
                        )}
                    </div>
                </div>

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

            <dl className="divide-y divide-border rounded-lg border border-border">
                <MetaRow icon={User} label="Author" value={skill.ownerName ?? skill.ownerEmail ?? "Unknown"} />
                <MetaRow icon={Zap} label="Runs" value={String(skill.runCount)} />
                <MetaRow icon={CalendarClock} label="Last update" value={relativeTime(skill.updatedAt)} />
                <MetaRow icon={CalendarPlus} label="Date created" value={relativeTime(skill.createdAt)} />
            </dl>

            <SkillOverview skill={skill} />

            <div className="flex gap-2">
                {isOwner && skill.visibility === "private" && hasReadyVersion && (
                    <Button variant="ghost" onClick={onPublish}>Publish</Button>
                )}
            </div>
        </div>
    );
}

function SkillOverview({ skill }: { skill: Skill }) {
    // Older/still-importing skills have no stored SKILL.md body yet — fall back to
    // just the version/latest table.
    if (!skill.body) {
        return (
            <div className="divide-y divide-border rounded-lg border border-border text-sm">
                <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-muted-foreground">Version</span>
                    <span className="font-medium text-foreground">{skill.installedVersion ?? skill.latestVersion}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-muted-foreground">Latest</span>
                    <span className="font-medium text-foreground">{skill.latestVersion}</span>
                </div>
            </div>
        );
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
                    <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        Skill.md
                    </div>
                </div>
            </div>
        </div>
    );
}

function MetaRow({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
    return (
        <div className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-4 w-4" />
                {label}
            </span>
            <span className="font-medium text-foreground">{value}</span>
        </div>
    );
}
