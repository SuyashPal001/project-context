"use client";

import { Brain, Globe, FileSearch, CalendarClock, Network } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentDetail } from "@/components/platform/agents/types";

interface AgentSkillSectionProps {
    agentId: string;
    isOwner: boolean;
    brandingEnabled: boolean;
    tenantSlug: string;
    agent: AgentDetail | undefined;
    isLoading: boolean;
}

function isSupervisor(name: string): boolean {
    const n = name.toLowerCase();
    return n.includes("pm") || (n.includes("product") && !n.includes("prd"));
}

function fallbackDescription(name: string): string {
    const n = name.toLowerCase();
    if (isSupervisor(n)) {
        return "Orchestrates the full PM lifecycle — writes PRDs, generates roadmaps, and breaks milestones into engineering tasks by delegating to specialist agents. Use this when you want to plan and ship a feature end-to-end.";
    }
    if (n.includes("prd")) {
        return "Specialist agent for writing and refining Product Requirements Documents. Saves PRDs to your workspace so the roadmap agent can pick them up.";
    }
    if (n.includes("roadmap")) {
        return "Generates structured roadmaps with milestones from an approved PRD. Use after your PRD is ready.";
    }
    if (n.includes("task")) {
        return "Breaks approved milestones into concrete engineering tasks with acceptance criteria, priorities, and effort estimates.";
    }
    if (n.includes("architect")) {
        return "Technical architect with deep codebase knowledge. Reviews designs, proposes system architecture, and answers implementation questions.";
    }
    return "A general-purpose AI agent. Chat with it to search the web, analyse documents, and get work done.";
}

const BASE_CAPABILITIES = [
    { icon: Brain, label: "Conversation memory", description: "Remembers context across turns in the same session" },
    { icon: FileSearch, label: "Knowledge base", description: "Searches your uploaded documents via RAG" },
    { icon: Globe, label: "Web search", description: "Looks up live information from the internet" },
    { icon: CalendarClock, label: "Scheduled runs", description: "Can be triggered automatically on a cron schedule" },
];

const SUPERVISOR_CAPABILITY = {
    icon: Network,
    label: "Delegates to specialist agents",
    description: "Spins up PRD, Roadmap, and Task agents to handle each phase — you only talk to one agent",
};

interface CapabilityItem {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    description: string;
}

export function AgentSkillSection({ agent, isLoading }: AgentSkillSectionProps) {
    const name = agent?.name ?? "";
    const description = agent?.description?.trim()
        ? agent.description
        : fallbackDescription(name);

    const capabilities: CapabilityItem[] = isSupervisor(name)
        ? [SUPERVISOR_CAPABILITY, ...BASE_CAPABILITIES]
        : BASE_CAPABILITIES;

    return (
        <>
            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div>
                        <h3 className="text-sm font-semibold">About this agent</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            What this agent does and when to use it.
                        </p>
                    </div>
                    {isLoading ? (
                        <div className="space-y-2">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-4/5" />
                            <Skeleton className="h-4 w-3/5" />
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            {description}
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div>
                        <h3 className="text-sm font-semibold">Capabilities</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            What this agent can do during a conversation.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {capabilities.map(({ icon: Icon, label, description: cap }) => (
                            <div
                                key={label}
                                className="flex items-start gap-3 rounded-lg border border-border bg-muted/10 px-4 py-3"
                            >
                                <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                <div className="space-y-0.5">
                                    <p className="text-sm font-medium">{label}</p>
                                    <p className="text-xs text-muted-foreground">{cap}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </>
    );
}
