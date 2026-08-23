"use client";

import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CatalogueEntry } from "./_catalogue";

interface Integration {
    createdAt: string | Date;
}

interface IntegrationCardProps {
    entry: CatalogueEntry;
    connected: boolean;
    integration: Integration | undefined;
    connecting: string | null;
    canConnect: boolean;
    canDelete: boolean;
    onConnect: (entry: CatalogueEntry) => void;
    onDisconnect: (entry: CatalogueEntry) => void;
}

export function IntegrationCard({
    entry, connected, integration, connecting, canConnect, canDelete, onConnect, onDisconnect,
}: IntegrationCardProps) {
    return (
        <div
            className={cn(
                "rounded-xl border bg-card p-6 flex flex-col gap-4 transition-colors",
                entry.available ? "border-border" : "border-border/40"
            )}
        >
            <div className="flex items-start justify-between">
                <div className="h-14 w-14 rounded-xl bg-muted flex items-center justify-center shrink-0">
                    {entry.icon}
                </div>
                {entry.requiresApproval && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-sm border"
                        style={{ color: '#fbbf24', borderColor: 'rgba(251,191,36,0.3)', background: 'rgba(251,191,36,0.08)' }}>
                        Requires Approval
                    </span>
                )}
                {!entry.requiresApproval && !entry.available && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border/50 rounded-full px-2 py-0.5">
                        Coming soon
                    </span>
                )}
                {entry.available && connected && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-500">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Connected
                    </span>
                )}
            </div>

            <div className="flex-1 space-y-1">
                <h3 className="font-semibold text-foreground text-sm">{entry.name}</h3>
                <p className="text-xs text-muted-foreground">{entry.description}</p>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {entry.scopes.map((scope) => (
                    <span
                        key={scope}
                        className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
                    >
                        {scope}
                    </span>
                ))}
            </div>

            <div className="border-t border-border/50 pt-4 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                    {connected && integration
                        ? `Connected ${formatDistanceToNow(new Date(integration.createdAt), { addSuffix: true })}`
                        : ''}
                </span>

                <div className="ml-auto">
                    {entry.available ? (
                        connected ? (
                            <Button
                                variant="outline"
                                size="sm"
                                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => onDisconnect(entry)}
                                disabled={!canDelete}
                            >
                                Disconnect
                            </Button>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => onConnect(entry)}
                                disabled={connecting !== null || !canConnect}
                            >
                                {connecting === entry.provider ? (
                                    <>
                                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                        Connecting...
                                    </>
                                ) : (
                                    'Connect'
                                )}
                            </Button>
                        )
                    ) : entry.requiresApproval ? (
                        <Button size="sm" variant="outline" disabled className="opacity-50 cursor-not-allowed">
                            Request Access
                        </Button>
                    ) : (
                        <span className="text-[11px] font-medium text-muted-foreground">Coming soon</span>
                    )}
                </div>
            </div>
        </div>
    );
}
