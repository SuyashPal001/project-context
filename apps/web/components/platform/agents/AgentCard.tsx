"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Agent } from "./types";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Play, Pause, Trash2, Settings2, Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { EmployeeCard } from "@/components/platform/shared/EmployeeCard";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { agentDescription } from "./agentDescription";

interface AgentCardProps {
    agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
    const queryClient = useQueryClient();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const [isRetireDialogOpen, setIsRetireDialogOpen] = useState(false);
    const [fireDependencies, setFireDependencies] = useState<{ shiftsCount: number; teamsCount: number } | null>(null);

    const updateStatusMutation = useMutation({
        mutationFn: ({ status, force }: { status: Agent["status"]; force?: boolean }) =>
            api.patch(`/api/v1/agents/${agent.id}`, { status, force }),
        onSuccess: () => {
            setFireDependencies(null);
            queryClient.invalidateQueries({ queryKey: ["agents"] });
        },
        onError: (err) => {
            if (err instanceof ApiError && err.status === 409) {
                setIsRetireDialogOpen(false);
                setFireDependencies({ shiftsCount: err.data?.shiftsCount ?? 0, teamsCount: err.data?.teamsCount ?? 0 });
            }
        },
    });

    const getStatusDotVariant = (status: Agent["status"]) => {
        switch (status) {
            case "active": return "bg-green-500";
            case "paused": return "bg-yellow-500";
            case "retired": return "bg-zinc-500";
            default: return "bg-zinc-500";
        }
    };

    const getStatusLabel = (status: Agent["status"]) => {
        switch (status) {
            case "active": return "Hired";
            case "paused": return "On Leave";
            case "retired": return "Fired";
            default: return status;
        }
    };

    const isRetired = agent.status === "retired";

    const outcomes = [
        agent.persona?.exampleAssetUrl && { url: agent.persona.exampleAssetUrl, caption: agent.persona.exampleCaption },
        agent.persona?.exampleAssetUrl2 && { url: agent.persona.exampleAssetUrl2, caption: agent.persona.exampleCaption2 },
    ].filter((o): o is { url: string; caption: string | null } => Boolean(o));

    return (
        <>
            <EmployeeCard
                href={`/${tenantSlug}/dashboard/agents/${agent.id}`}
                avatar={<PersonaAvatar persona={agent.persona} avatarUrl={agent.avatarUrl} size={44} className="rounded-2xl" />}
                name={agent.name}
                subtitle={
                    <div className="space-y-1">
                        <span className="inline-flex items-center gap-1.5">
                            <Brain className="h-3.5 w-3.5 text-muted-foreground" /> {agent.model ?? `${agent.name} v1`}
                        </span>
                        <p className="line-clamp-2">{agentDescription(agent.name, agent.description)}</p>
                    </div>
                }
                dimmed={isRetired}
                action={
                    <div className="flex items-center gap-1" onClick={(e) => e.preventDefault()}>
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
                            <span className={cn("h-2.5 w-2.5 rounded-full", getStatusDotVariant(agent.status))} /> {getStatusLabel(agent.status)}
                        </span>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild disabled={isRetired}>
                                <Button variant="ghost" size="icon" className="h-8 w-8 p-0">
                                    <span className="sr-only">Open menu</span>
                                    <MoreHorizontal className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                    <Link href={`/${tenantSlug}/dashboard/agents/${agent.id}`}>
                                        <Settings2 className="mr-2 h-4 w-4" />
                                        Configure
                                    </Link>
                                </DropdownMenuItem>
                                {agent.status === "active" && (
                                    <DropdownMenuItem onClick={() => updateStatusMutation.mutate({ status: "paused" })}>
                                        <Pause className="mr-2 h-4 w-4" />
                                        Put on leave
                                    </DropdownMenuItem>
                                )}
                                {agent.status === "paused" && (
                                    <DropdownMenuItem onClick={() => updateStatusMutation.mutate({ status: "active" })}>
                                        <Play className="mr-2 h-4 w-4" />
                                        Return from leave
                                    </DropdownMenuItem>
                                )}
                                {(agent.status === "active" || agent.status === "paused") && (
                                    <DropdownMenuItem
                                        className="text-muted-foreground focus:text-foreground cursor-pointer"
                                        onClick={() => setIsRetireDialogOpen(true)}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Fire employee
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                }
                skillTags={agent.persona?.skillTags ?? []}
                outcomes={outcomes}
            />

            <AlertDialog open={isRetireDialogOpen} onOpenChange={setIsRetireDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Fire this employee?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently deactivate the employee and revoke its API
                            key. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => updateStatusMutation.mutate({ status: "retired" })}
                        >
                            Fire employee
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={fireDependencies !== null} onOpenChange={(open) => !open && setFireDependencies(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Fire this employee?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This employee is related to {fireDependencies?.shiftsCount ?? 0} Shifts, {fireDependencies?.teamsCount ?? 0} Teams.
                            Are you sure you want to fire this employee?
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel variant="ghost">Cancel Fire</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => updateStatusMutation.mutate({ status: "retired", force: true })}
                        >
                            Fire
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
