import { formatDistanceToNow } from "date-fns";
import { CalendarClock, CalendarPlus, Package, Plus, User, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { skillImportState } from "./SkillCard";
import type { Skill } from "./types";

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

            <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="space-y-1.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Description</h4>
                    <p className="text-sm text-foreground">{skill.description ?? "No description"}</p>
                </div>

                <div className="divide-y divide-border border-t border-border pt-1 text-sm">
                    <div className="flex items-center justify-between py-1.5">
                        <span className="text-muted-foreground">Version</span>
                        <span className="font-medium text-foreground">{skill.installedVersion ?? skill.latestVersion}</span>
                    </div>
                    <div className="flex items-center justify-between py-1.5">
                        <span className="text-muted-foreground">Latest</span>
                        <span className="font-medium text-foreground">{skill.latestVersion}</span>
                    </div>
                </div>
            </div>

            <dl className="divide-y divide-border rounded-lg border border-border">
                <MetaRow icon={User} label="Author" value={skill.isOfficial ? "Official" : skill.visibility === "public" ? "Community" : "Private"} />
                <MetaRow icon={Zap} label="Runs" value="—" />
                <MetaRow icon={CalendarClock} label="Last update" value={formatDistanceToNow(new Date(skill.updatedAt), { addSuffix: true })} />
                <MetaRow icon={CalendarPlus} label="Date created" value={formatDistanceToNow(new Date(skill.createdAt), { addSuffix: true })} />
            </dl>

            <div className="flex gap-2">
                {isOwner && skill.visibility === "private" && hasReadyVersion && (
                    <Button variant="ghost" onClick={onPublish}>Publish</Button>
                )}
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
