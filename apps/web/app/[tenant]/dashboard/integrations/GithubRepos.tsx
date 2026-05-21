"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Github, GitBranch } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

interface GithubRepo {
    id: string;
    repoOwner: string;
    repoName: string;
    repoFullName: string;
    defaultBranch: string;
    lastSyncedAt: string | null;
    createdAt: string;
}

interface ReposResponse {
    repos: GithubRepo[];
}

export function GithubRepos() {
    const { data, isLoading } = useQuery<ReposResponse>({
        queryKey: ['github-repos'],
        queryFn: () => api.get<ReposResponse>('/api/v1/integrations/github/repos'),
        staleTime: 30_000,
    });

    const repos = data?.repos ?? [];

    return (
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center gap-2">
                <Github className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold tracking-tight">Connected GitHub repos</h2>
            </div>

            {isLoading ? (
                <div className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : repos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    No repos linked yet. After installing the GitHub App, accessible repos appear here.
                </p>
            ) : (
                <ul className="space-y-2">
                    {repos.map((r) => (
                        <li
                            key={r.id}
                            className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-xs"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <Github className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="font-mono truncate">{r.repoFullName}</span>
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <GitBranch className="h-3 w-3" />
                                    {r.defaultBranch}
                                </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground shrink-0 ml-3">
                                {r.lastSyncedAt
                                    ? `Synced ${formatDistanceToNow(new Date(r.lastSyncedAt), { addSuffix: true })}`
                                    : 'Awaiting first sync'}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
