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
                        {skill.isOfficial && <Badge variant="secondary">Official</Badge>}
                        {skill.visibility === "public" && <Badge variant="outline">Public</Badge>}
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    v{skill.latestVersion}{skill.installed ? ` — installed v${skill.installedVersion}` : ""}
                </p>

                <div className="flex gap-2">
                    {skill.installed ? (
                        <Button size="sm" variant="outline" onClick={onUninstall}>Uninstall</Button>
                    ) : (
                        <Button size="sm" onClick={onInstall} disabled={skill.latestVersion < 1}>
                            {skill.latestVersion < 1 ? "Importing…" : "Install"}
                        </Button>
                    )}
                    {isOwner && skill.visibility === "private" && (
                        <Button size="sm" variant="ghost" onClick={onPublish}>Publish</Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
