import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Skill } from "./types";

interface OfficialSkillCardProps {
    skill: Skill;
    onClick: () => void;
}

/**
 * Showcase card for an Official skill — a portrait example image, name, one-line
 * description and Best-for chips. No install button, no run/download counts, no
 * version: those are community-card concepts, and Official skills are curated,
 * always-latest presets rather than something a tenant installs and tracks.
 * The caller (skills/page.tsx) only renders this when `skill.showcase` is
 * present; falls back to plain <SkillCard> otherwise.
 */
export function OfficialSkillCard({ skill, onClick }: OfficialSkillCardProps) {
    const bestFor = skill.showcase?.bestFor ?? [];

    return (
        // Not a <button>: matches SkillCard's own reasoning — role/tabIndex/
        // onKeyDown keep it keyboard-operable as a div wrapper.
        <div
            role="button"
            aria-label={skill.name}
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onClick();
                }
            }}
            className="block w-full cursor-pointer text-left"
        >
            <Card className="h-full overflow-hidden transition-colors hover:border-input">
                <div className="relative aspect-[3/4] w-full bg-muted">
                    {skill.showcase?.imageUrl && (
                        <Image
                            src={skill.showcase.imageUrl}
                            alt={skill.name}
                            fill
                            className="object-cover"
                        />
                    )}
                </div>
                <CardContent className="space-y-1.5 pt-3">
                    <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-1">
                        {skill.description ?? "No description"}
                    </p>
                    {bestFor.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                            {bestFor.map((tag) => (
                                <Badge key={tag} variant="outline" className="text-[10px] font-medium">
                                    {tag}
                                </Badge>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
