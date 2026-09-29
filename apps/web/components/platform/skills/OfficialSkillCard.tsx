import { ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OFFICIAL_SKILL_PATTERNS, SkillIcon } from "./SkillIcon";
import type { Skill } from "./types";

interface OfficialSkillCardProps {
    skill: Skill;
    onClick: () => void;
    onStart: () => void;
    isStarting?: boolean;
}

/**
 * Official-skill card, aligned to the same outer card shape/size/grid as the
 * Community <SkillCard> — the big showcase image lives only in the detail
 * modal (OfficialSkillDetail). The icon slot uses the same pixel <SkillIcon>
 * as the Community card, but with a hand-designed pattern keyed by slug
 * (OFFICIAL_SKILL_PATTERNS) instead of the seeded random one — unknown
 * official slugs fall back to the random pattern. The owner line reads
 * "Platform", the bottom row mirrors the Community card's bottom row exactly
 * (Best-for tags as one truncated line on the left, "Recreate" in place of
 * "Install" on the right). No install button, no run/download counts, no
 * version: those are community-card concepts, and Official skills are
 * curated, always-latest presets rather than something a tenant installs and
 * tracks. The caller (skills/page.tsx) only renders this when
 * `skill.showcase` is present; falls back to plain <SkillCard> otherwise.
 */
export function OfficialSkillCard({ skill, onClick, onStart, isStarting = false }: OfficialSkillCardProps) {
    const bestFor = skill.showcase?.bestFor ?? [];
    const visibleTags = bestFor.slice(0, 2);
    const remainingCount = bestFor.length - visibleTags.length;
    const tagsLine =
        remainingCount > 0 ? `${visibleTags.join(" · ")} +${remainingCount}` : visibleTags.join(" · ");

    return (
        // Not a <button>: the Recreate control below is a real nested button, and
        // HTML forbids nesting interactive elements. role/tabIndex/onKeyDown keep
        // the whole card keyboard-operable, matching SkillCard.
        <div
            role="button"
            aria-label={skill.name}
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onClick();
                }
            }}
            className="block w-full cursor-pointer text-left"
        >
            <Card className="h-full transition-colors hover:border-input">
                <CardContent className="pt-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <SkillIcon
                                seed={skill.id}
                                pattern={OFFICIAL_SKILL_PATTERNS[skill.slug]}
                                inverted
                                className="h-12 w-12 rounded-lg border border-border shrink-0"
                            />
                            <div className="min-w-0 space-y-0.5">
                                <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                                <p className="text-xs text-muted-foreground truncate">Platform</p>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <Badge
                                variant="outline"
                                className="text-[10px] font-semibold uppercase tracking-wider shrink-0 border-primary/40 text-primary"
                            >
                                Official
                            </Badge>
                        </div>
                    </div>

                    <p className="text-sm text-muted-foreground line-clamp-2">
                        {skill.description ?? "No description"}
                    </p>

                    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                        <span
                            className="min-w-0 truncate"
                            title={remainingCount > 0 ? bestFor.join(" · ") : undefined}
                        >
                            {tagsLine}
                        </span>

                        <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="shrink-0 font-medium text-foreground"
                            disabled={isStarting}
                            onClick={(e) => {
                                // Without this the card's own onClick fires too and the
                                // detail modal opens on top of Recreate.
                                e.stopPropagation();
                                onStart();
                            }}
                        >
                            {isStarting ? (
                                "Starting…"
                            ) : (
                                <>
                                    Recreate
                                    <ArrowUpRight />
                                </>
                            )}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
