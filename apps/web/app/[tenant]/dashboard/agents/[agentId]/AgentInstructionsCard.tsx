"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentDetail } from "@/components/platform/agents/types";

interface AgentInstructionsCardProps {
    agent: AgentDetail | undefined;
    isLoading: boolean;
}

// Read-only for now — editing (and who's allowed to) is a separate,
// not-yet-decided piece of work. This card exists so the system prompt that
// actually drives the agent's behavior is visible somewhere, instead of
// being fetched every request and silently unused (the bug this field's
// wiring just fixed).
export function AgentInstructionsCard({ agent, isLoading }: AgentInstructionsCardProps) {
    return (
        <Card>
            <CardContent className="pt-6">
                <h3 className="text-sm font-semibold mb-1">Instructions</h3>
                <p className="text-xs text-muted-foreground mb-3">
                    {agent?.origin === "built_in"
                        ? "The built-in agent's instructions are fixed by the platform."
                        : "What this agent is told to do. Read-only for now."}
                </p>
                {isLoading ? (
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                ) : agent?.systemPrompt ? (
                    <pre className="whitespace-pre-wrap text-sm text-foreground bg-secondary/50 rounded-md p-3 max-h-96 overflow-y-auto font-sans">
                        {agent.systemPrompt}
                    </pre>
                ) : (
                    <p className="text-sm text-muted-foreground">No custom instructions set — this agent uses its default behavior.</p>
                )}
            </CardContent>
        </Card>
    );
}
