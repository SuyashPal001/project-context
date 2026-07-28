"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EmptyState, StatusBadge } from "@/components/platform/shared";
import { IntegrationPanel } from "@/components/platform/integrations/IntegrationPanel";
import { Loader2, Blocks, Github, Slack, Calendar, Server, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

export function IntegrationsGrid() {
    const [selectedIntegration, setSelectedIntegration] = useState<any | null>(null);

    const { data: response, isLoading } = useQuery({
        queryKey: ['integrations'],
        queryFn: () => api.get<{ integrations: any[] }>('/api/v1/integrations')
    });

    if (isLoading) {
        return (
            <div className="flex justify-center py-12 flex-col items-center gap-4 text-muted-foreground border border-zinc-800 rounded-lg bg-card">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p>Loading integrations...</p>
            </div>
        );
    }

    const integrations = response?.integrations || [];

    if (integrations.length === 0) {
        return (
            <div className="py-6">
                <EmptyState
                    icon={<Blocks className="w-12 h-12" />}
                    title="No active integrations"
                    description="Connect your workspace natively with powerful third-party providers or custom MCP servers."
                />
            </div>
        );
    }

    const getProviderIcon = (provider: string) => {
        switch (provider) {
            case 'github': return <Github className="w-8 h-8 text-zinc-100" />;
            case 'slack': return <Slack className="w-8 h-8 text-zinc-100 fill-zinc-100" />;
            case 'google_calendar': return <Calendar className="w-8 h-8 text-zinc-100" />;
            case 'jira': return <div className="font-bold text-2xl text-blue-500 tracking-tighter">Jira</div>;
            case 'custom_mcp': return <Server className="w-8 h-8 text-amber-500" />;
            default: return <Blocks className="w-8 h-8 text-zinc-400" />;
        }
    };

    const getProviderName = (provider: string) => {
        return provider.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    };

    return (
        <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {integrations.map((integration: any) => (
                    <div
                        key={integration.id}
                        onClick={() => setSelectedIntegration(integration)}
                        className="group bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-all cursor-pointer flex flex-col items-start gap-5 relative overflow-hidden shadow-sm hover:shadow-md"
                    >
                        <div className="flex justify-between w-full items-start">
                            <div className="h-16 w-16 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center shadow-inner">
                                {getProviderIcon(integration.provider)}
                            </div>
                            <Button variant="ghost" size="icon" className="text-zinc-500 hover:text-zinc-200">
                                <MoreHorizontal className="w-5 h-5" />
                            </Button>
                        </div>

                        <div className="space-y-1.5 w-full">
                            <h3 className="font-bold text-zinc-100 text-lg truncate pr-2">{integration.name}</h3>
                            <p className="text-zinc-500 text-sm font-medium">{getProviderName(integration.provider)} Connection</p>
                        </div>

                        <div className="mt-1 w-full flex items-center justify-between border-t border-zinc-800/50 pt-5">
                            <StatusBadge status={integration.status} />
                            <span className="text-xs text-zinc-600 font-mono tracking-wide">
                                ID: {integration.id.substring(0, 8)}...
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <IntegrationPanel
                integration={selectedIntegration}
                open={!!selectedIntegration}
                onOpenChange={(open: boolean) => !open && setSelectedIntegration(null)}
            />
        </>
    );
}
