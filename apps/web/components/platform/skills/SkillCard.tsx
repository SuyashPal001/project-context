import Link from "next/link";
import { ArrowUp, Download, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillIcon } from "./SkillIcon";
import type { Skill } from "./types";

interface SkillCardProps {
    skill: Skill;
    href: string;
}

// A failed import leaves latestVersion at 0 forever, exactly like a still-running
// one — so the version number alone can't tell them apart. Branch on the newest
// version row's own status instead. Shared with the skill detail page so both
// agree on install/failed/importing state.
export function skillImportState(skill: Skill) {
    const importFailed = skill.latestVersionStatus === "failed";
    const hasReadyVersion = skill.latestVersion >= 1;
    const dead = importFailed && !hasReadyVersion;
    const importing = !importFailed && !hasReadyVersion;
    return { importFailed, hasReadyVersion, dead, importing };
}

export function SkillCard({ skill, href }: SkillCardProps) {
    const { importFailed, hasReadyVersion, dead, importing } = skillImportState(skill);

    const status = importFailed
        ? {
            label: dead ? "Failed" : "Update failed",
            className: "border-destructive/30 text-destructive dark:border-destructive/40",
        }
        : importing
            ? {
                label: "Importing",
                className: "border-amber-600/30 text-amber-700 dark:border-amber-500/30 dark:text-amber-400",
            }
            : skill.isOfficial
                ? {
                    label: "Official",
                    className: "border-indigo-600/30 text-indigo-700 dark:border-indigo-500/30 dark:text-indigo-400",
                }
                : skill.visibility === "public"
                    ? {
                        label: "Community",
                        className: "border-teal-600/30 text-teal-700 dark:border-teal-500/30 dark:text-teal-400",
                    }
                    : {
                        label: "Private",
                        className: "border-border text-muted-foreground",
                    };

    return (
        <Link href={href} className="block">
            <Card className="h-full transition-colors hover:border-input">
                <CardContent className="pt-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <SkillIcon seed={skill.id} className="h-8 w-8 rounded-lg border border-border shrink-0" />
                            <div className="min-w-0 space-y-1">
                                <h3 className="font-semibold text-foreground truncate">{skill.name}</h3>
                                <Badge variant="outline" className={cn("text-[11px] font-semibold uppercase tracking-wider", status.className)}>
                                    {status.label}
                                </Badge>
                            </div>
                        </div>
                        {// A real <button> can't nest inside the card's <Link>; this is styled
                        // as one since the whole card already navigates on click. Installed
                        // state is conveyed at the bottom of the card instead of a badge here.
                        !skill.installed && (
                            <span className={cn(buttonVariants({ variant: "outline", size: "xs" }), "shrink-0 pointer-events-none")}>
                                <Download />
                                Install
                            </span>
                        )}
                    </div>

                    <p className="text-sm text-muted-foreground line-clamp-2">
                        {skill.description ?? "No description"}
                    </p>

                    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1">
                                <ArrowUp className="h-3.5 w-3.5" />
                                {/* Run counts aren't tracked yet. */}
                                &mdash; runs
                            </span>
                            <span className="flex items-center gap-1">
                                <Download className="h-3.5 w-3.5" />
                                {/* Download counts aren't tracked yet. */}
                                &mdash;
                            </span>
                            {hasReadyVersion && (
                                <span className="flex items-center gap-1">
                                    <Package className="h-3.5 w-3.5" />
                                    v{skill.latestVersion}
                                </span>
                            )}
                        </div>

                        {skill.installed && (
                            <span className="text-green-600 dark:text-green-500 shrink-0">
                                {skill.installedVersion !== skill.latestVersion
                                    ? `installed v${skill.installedVersion}`
                                    : "installed"}
                            </span>
                        )}
                    </div>
                </CardContent>
            </Card>
        </Link>
    );
}
