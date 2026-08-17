"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Agent } from "./types";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Play, Pause, Trash2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface AgentCardProps {
    agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
    const queryClient = useQueryClient();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const [isRetireDialogOpen, setIsRetireDialogOpen] = useState(false);
    const [fireDependencies, setFireDependencies] = useState<{ shiftsCount: number; teamsCount: number } | null>(null);

    const formatRelativeTime = (date: string) => {
        const now = new Date();
        const diff = now.getTime() - new Date(date).getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return "just now";
    };

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

    const getStatusBadgeVariant = (status: Agent["status"]) => {
        switch (status) {
            case "active":
                return "bg-green-500/10 text-green-500 border-green-500/20";
            case "paused":
                return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
            case "retired":
                return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
            default:
                return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
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

    const getTypeBadgeVariant = () => "bg-secondary text-muted-foreground border-border";

    const getTypeLabel = (type: Agent["type"]) => {
        switch (type) {
            case "product_manager": return "Product Manager";
            case "project_manager": return "Project Manager";
            case "tech_lead": return "Tech Lead";
            case "analyst": return "Analyst";
            case "architect": return "Architect";
            default: return type;
        }
    };

    const isRetired = agent.status === "retired";

    return (
        <>
            <Link
                href={`/${tenantSlug}/dashboard/agents/${agent.id}`}
                className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
            <Card className="relative overflow-hidden transition-colors hover:border-foreground/20">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                    <div className="space-y-1">
                        <CardTitle className="text-xl font-bold">{agent.name}</CardTitle>
                        <CardDescription>
                            Created {formatRelativeTime(agent.createdAt)}
                        </CardDescription>
                    </div>
                    <div onClick={(e) => e.preventDefault()}>
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
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2 mb-4">
                        <Badge variant="outline" className={cn("capitalize", getTypeBadgeVariant())}>
                            {getTypeLabel(agent.type)}
                        </Badge>
                        <Badge variant="outline" className={cn(getStatusBadgeVariant(agent.status))}>
                            {getStatusLabel(agent.status)}
                        </Badge>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground border-t pt-4">
                        <span>Model</span>
                        <span className="font-medium text-foreground">{agent.model ?? `${agent.name} v1`}</span>
                    </div>
                </CardContent>
            </Card>
            </Link>

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
