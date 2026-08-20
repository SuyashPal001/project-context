"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Skill } from "./types";

interface SkillCardProps {
    skill: Skill;
    isOwner: boolean;
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
}

export function SkillCard({ skill, isOwner, onInstall, onUninstall, onPublish }: SkillCardProps) {
    // A failed import leaves latestVersion at 0 forever, exactly like a
    // still-running one — so the version number alone can't tell them apart.
    // Branch on the newest version row's own status instead.
    const importFailed = skill.latestVersionStatus === "failed";
    const hasReadyVersion = skill.latestVersion >= 1;
    // Nothing installable and the last import failed: this card is terminal.
    const dead = importFailed && !hasReadyVersion;
    const importing = !importFailed && !hasReadyVersion;

    return (
        <Card>
            <CardContent className="pt-6 space-y-3">
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <h3 className="text-sm font-semibold">{skill.name}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {skill.description ?? "No description"}
                        </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                        {importFailed && <Badge variant="destructive">{dead ? "Failed" : "Update failed"}</Badge>}
                        {skill.isOfficial && <Badge variant="secondary">Official</Badge>}
                        {skill.visibility === "public" && <Badge variant="outline">Public</Badge>}
                    </div>
                </div>

                {hasReadyVersion && (
                    <p className="text-xs text-muted-foreground">
                        v{skill.latestVersion}{skill.installed ? ` — installed v${skill.installedVersion}` : ""}
                    </p>
                )}
                {importFailed && (
                    <p className="text-xs text-destructive line-clamp-3">
                        {skill.failureReason ?? "Import failed."}
                    </p>
                )}

                <div className="flex gap-2">
                    {skill.installed ? (
                        <Button size="sm" variant="outline" onClick={onUninstall}>Uninstall</Button>
                    ) : dead ? null : (
                        <Button size="sm" onClick={onInstall} disabled={importing}>
                            {importing ? "Importing…" : "Install"}
                        </Button>
                    )}
                    {isOwner && skill.visibility === "private" && hasReadyVersion && (
                        <Button size="sm" variant="ghost" onClick={onPublish}>Publish</Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
