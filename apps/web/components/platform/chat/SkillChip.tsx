"use client";

import { X } from "lucide-react";
import { SkillIcon } from "@/components/platform/skills/SkillIcon";
import type { Skill } from "@/components/platform/skills/types";

interface SkillChipProps {
    // Only id (icon seed) and name are rendered.
    skill: Pick<Skill, "id" | "name">;
    onRemove: () => void;
}

/**
 * A skill in the composer: either a "/" pick in this draft, or a skill already
 * turned on in this conversation. Removing it never touches the agent — a
 * draft chip is dropped from the message, and a conversation chip is turned
 * off for this conversation only.
 */
export function SkillChip({ skill, onRemove }: SkillChipProps) {
    return (
        <div className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-secondary border border-border text-xs w-fit">
            <SkillIcon seed={skill.id} className="h-5 w-5 rounded-full shrink-0" />
            <span className="font-medium text-foreground truncate max-w-[160px]">{skill.name}</span>
            <button
                type="button"
                onClick={onRemove}
                title="Dismiss"
                className="h-4 w-4 flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive shrink-0"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    );
}
