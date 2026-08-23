"use client";

import { motion } from "motion/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Skill } from "./types";

interface SkillCardProps {
    skill: Skill;
    layoutId: string;
    titleLayoutId: string;
    descriptionLayoutId: string;
    isOwner: boolean;
    onExpand: () => void;
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
}

// A failed import leaves latestVersion at 0 forever, exactly like a still-running
// one — so the version number alone can't tell them apart. Branch on the newest
// version row's own status instead. Shared with SkillDetailPanel so the compact
// card and the expanded panel agree on state.
export function skillImportState(skill: Skill) {
    const importFailed = skill.latestVersionStatus === "failed";
    const hasReadyVersion = skill.latestVersion >= 1;
    const dead = importFailed && !hasReadyVersion;
    const importing = !importFailed && !hasReadyVersion;
    return { importFailed, hasReadyVersion, dead, importing };
}

export function SkillCard({
    skill, layoutId, titleLayoutId, descriptionLayoutId, isOwner, onExpand, onInstall, onUninstall, onPublish,
}: SkillCardProps) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);

    return (
        <motion.div layoutId={layoutId} onClick={onExpand} className="cursor-pointer">
            <Card className="h-full transition-colors hover:border-input">
                <CardContent className="pt-6 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                        <div>
                            <motion.h3 layoutId={titleLayoutId} className="text-sm font-semibold">
                                {skill.name}
                            </motion.h3>
                            <motion.p layoutId={descriptionLayoutId} className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                {skill.description ?? "No description"}
                            </motion.p>
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

                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
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
        </motion.div>
    );
}
