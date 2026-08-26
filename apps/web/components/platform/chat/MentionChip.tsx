"use client";

import { X } from "lucide-react";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "../agents/agentTypeIcon";
import type { Agent } from "../agents/types";

interface MentionChipProps {
    agent: Agent;
    onRemove: () => void;
}

/**
 * The selected @mention target, shown as a standalone removable chip next to
 * the textarea rather than woven into the message text — so it reads like a
 * recipient, not like something the user typed.
 */
export function MentionChip({ agent, onRemove }: MentionChipProps) {
    return (
        <div className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-secondary border border-border text-xs w-fit">
            <PersonaAvatar persona={agent.persona} avatarUrl={agent.avatarUrl} size={20} className="rounded-full" icon={getAgentTypeIcon(agent.type)} />
            <span className="font-medium text-foreground truncate max-w-[160px]">{agent.name}</span>
            <button
                type="button"
                onClick={onRemove}
                title="Remove mention"
                className="h-4 w-4 flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive shrink-0"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    );
}
