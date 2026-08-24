import Link from "next/link";
import { ArrowRight, ArrowUp, Download, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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

    const statusLabel = importFailed
        ? (dead ? "Failed" : "Update failed")
        : importing
            ? "Importing"
            : skill.isOfficial
                ? "Official"
                : skill.visibility === "public"
                    ? "Public"
                    : "Private";

    return (
        <Link href={href} className="block">
            <Card className="h-full transition-colors hover:border-input">
                <CardContent className="pt-6 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-foreground truncate">{skill.name}</h3>
                        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    </div>

                    <p className="text-sm text-muted-foreground line-clamp-2">
                        {skill.description ?? "No description"}
                    </p>

                    <div className="flex items-center justify-between pt-2">
                        <span className={cn(
                            "text-[11px] font-semibold uppercase tracking-wider",
                            importFailed ? "text-destructive" : "text-muted-foreground"
                        )}>
                            {statusLabel}
                        </span>
                        {hasReadyVersion && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Package className="h-3.5 w-3.5" />
                                v{skill.latestVersion}
                                {skill.installed && skill.installedVersion !== skill.latestVersion
                                    ? ` (installed v${skill.installedVersion})`
                                    : skill.installed ? " · installed" : ""}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
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
                    </div>
                </CardContent>
            </Card>
        </Link>
    );
}
