"use client";

import { useRef } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { skillImportState } from "./SkillCard";
import type { Skill } from "./types";

interface SkillDetailPanelProps {
    skill: Skill;
    layoutId: string;
    titleLayoutId: string;
    descriptionLayoutId: string;
    isOwner: boolean;
    onClose: () => void;
    onInstall: () => void;
    onUninstall: () => void;
    onPublish: () => void;
}

export function SkillDetailPanel({
    skill, layoutId, titleLayoutId, descriptionLayoutId, isOwner, onClose, onInstall, onUninstall, onPublish,
}: SkillDetailPanelProps) {
    const ref = useRef<HTMLDivElement>(null);
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);

    useOutsideClick(ref, onClose);

    return (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
            <motion.div
                layoutId={layoutId}
                ref={ref}
                className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl"
            >
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <motion.h3 layoutId={titleLayoutId} className="text-lg font-semibold">
                            {skill.name}
                        </motion.h3>
                        <motion.p layoutId={descriptionLayoutId} className="text-sm text-muted-foreground mt-1">
                            {skill.description ?? "No description"}
                        </motion.p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { delay: 0.1 } }}
                    exit={{ opacity: 0 }}
                    className="mt-5 space-y-5"
                >
                    <div className="flex flex-wrap gap-1.5">
                        {importFailed && <Badge variant="destructive">{dead ? "Failed" : "Update failed"}</Badge>}
                        {skill.isOfficial && <Badge variant="secondary">Official</Badge>}
                        <Badge variant="outline">{skill.visibility === "public" ? "Public" : "Private"}</Badge>
                        {hasReadyVersion && (
                            <Badge variant="outline">
                                v{skill.latestVersion}{skill.installed ? ` — installed v${skill.installedVersion}` : ""}
                            </Badge>
                        )}
                    </div>

                    {importFailed && skill.failureReason && (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                            <p className="text-xs font-medium text-destructive mb-1">Import failed</p>
                            <p className="text-xs text-destructive/90">{skill.failureReason}</p>
                        </div>
                    )}

                    <dl className="grid grid-cols-2 gap-y-2 text-sm">
                        <dt className="text-muted-foreground">Created</dt>
                        <dd className="text-right">{new Date(skill.createdAt).toLocaleDateString()}</dd>
                    </dl>

                    <div className="flex gap-2 pt-1">
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
                </motion.div>
            </motion.div>
        </div>
    );
}
