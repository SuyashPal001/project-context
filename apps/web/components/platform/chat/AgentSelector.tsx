"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Agent, AgentsResponse } from "../agents/types";
import { Bot } from "lucide-react";

interface AgentSelectorProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (agent: Agent) => void;
}

export function AgentSelector({ open, onOpenChange, onSelect }: AgentSelectorProps) {
    const { data: agentsData, isLoading } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
        enabled: open,
    });

    const activeAgents = agentsData?.data?.filter(a => a.status === 'active') || [];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Select an Agent</DialogTitle>
                    <DialogDescription>
                        Choose an agent to start a new conversation.
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                    <div className="grid gap-2">
                        {isLoading ? (
                            Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-12 w-full" />
                            ))
                        ) : activeAgents.length > 0 ? (
                            activeAgents.map((agent) => (
                                <Button
                                    key={agent.id}
                                    variant="outline"
                                    className="flex items-center justify-start gap-3 h-auto py-3 w-full text-left"
                                    onClick={() => onSelect(agent)}
                                >
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        <Bot className="h-4 w-4" />
                                    </div>
                                    <div className="flex flex-col items-start overflow-hidden">
                                        <span className="font-medium truncate w-full">{agent.name}</span>
                                        <span className="text-xs text-muted-foreground line-clamp-2 whitespace-normal">
                                            {agent.description ?? agent.type + ' agent'}
                                        </span>
                                    </div>
                                </Button>
                            ))
                        ) : (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                                No active agents found.
                            </div>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
