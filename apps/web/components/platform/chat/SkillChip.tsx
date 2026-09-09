"use client";

import { X } from "lucide-react";
import { SkillIcon } from "@/components/platform/skills/SkillIcon";
import type { Skill } from "@/components/platform/skills/types";

interface SkillChipProps {
    // Only id (icon seed) and name are rendered — accepts a full catalog
    // Skill (composer "/" pick) or a bare agent_skills row (already-attached,
    // fetched by agentId — see ChatInput's attachedSkills).
    skill: Pick<Skill, "id" | "name">;
    onRemove: () => void;
}

/**
 * Visual confirmation that a skill was picked via "/" in this draft. The
 * attach itself already happened (agent-level, via handleAttachSkill) the
 * moment the skill was selected — removing this chip only clears the
 * per-draft indicator, it does not detach the skill from the agent.
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
