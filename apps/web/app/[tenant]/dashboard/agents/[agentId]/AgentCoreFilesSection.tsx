"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { getAgentMemory, saveAgentMemory } from "@/components/platform/agents/coreFilesActions";

interface AgentCoreFilesSectionProps {
    agentId: string;
}

export function AgentCoreFilesSection({ agentId }: AgentCoreFilesSectionProps) {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<string | undefined>(undefined);
    const [loadedAgentId, setLoadedAgentId] = useState<string | undefined>(undefined);

    const { data: memory, isLoading: memoryLoading } = useQuery({
        queryKey: ["agent-memory", agentId],
        queryFn: () => getAgentMemory(agentId),
    });

    // Seed the draft from the fetched memory once per agent, without a
    // setState-in-effect: derive it during render the first time this
    // agent's memory arrives, same pattern React docs recommend for
    // "adjusting state when a prop changes".
    if (memory && loadedAgentId !== agentId) {
        setLoadedAgentId(agentId);
        setDraft(memory.content);
    }

    const saveMutation = useMutation({
        mutationFn: (content: string) => saveAgentMemory(agentId, content),
        onSuccess: (updated) => {
            queryClient.setQueryData(["agent-memory", agentId], updated);
            toast.success("MEMORY.md saved.");
        },
        onError: () => toast.error("Failed to save MEMORY.md."),
    });

    const isDirty = draft !== undefined && memory !== undefined && draft !== memory.content;

    return (
        <>
            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <h3 className="text-sm font-semibold">MEMORY.md</h3>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Persistent, tenant-specific context for this employee — project conventions, past
                                decisions, anything worth remembering across conversations.
                            </p>
                        </div>
                        <Button
                            size="sm"
                            disabled={!isDirty || saveMutation.isPending}
                            onClick={() => draft !== undefined && saveMutation.mutate(draft)}
                        >
                            {saveMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                            Save
                        </Button>
                    </div>
                    {memoryLoading ? (
                        <div className="h-40 animate-pulse rounded-lg bg-muted/30" />
                    ) : (
                        <Textarea
                            value={draft ?? memory?.content ?? ""}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Nothing remembered yet."
                            className="min-h-40 font-mono text-sm"
                        />
                    )}
                    {memory?.updatedAt && (
                        <p className="text-xs text-muted-foreground">
                            Last saved {new Date(memory.updatedAt).toLocaleString()}
                        </p>
                    )}
                </CardContent>
            </Card>
        </>
    );
}
