"use client";

import { Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import type { Agent } from "@/components/platform/agents/types";
import type { Team } from "./types";

interface TeamCardProps {
    team: Team;
    members: Agent[];
    onClick: () => void;
}

export function TeamCard({ team, members, onClick }: TeamCardProps) {
    const visible = members.slice(0, 4);
    const overflow = members.length - visible.length;

    return (
        <Card
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
            className="cursor-pointer overflow-hidden p-4 transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/50 bg-secondary text-muted-foreground">
                <Users className="h-1/2 w-1/2" />
            </div>

            <h3 className="mt-3 text-lg font-bold text-foreground">{team.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
                {members.length === 1 ? "1 member" : `${members.length} members`}
            </p>

            {members.length > 0 && (
                <div className="mt-3 flex -space-x-2">
                    {visible.map((agent) => (
                        <PersonaAvatar key={agent.id} persona={agent.persona} size={28} className="rounded-full ring-2 ring-background" />
                    ))}
                    {overflow > 0 && (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
                            +{overflow}
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
