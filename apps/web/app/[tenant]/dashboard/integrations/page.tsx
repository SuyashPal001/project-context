"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { api } from "@/lib/api";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useComposioIntegrations, type ComposioApp } from "@/hooks/useComposioIntegrations";
import { useTenant } from "@/app/[tenant]/tenant-provider";

import { CATALOGUE, CONNECT_URLS, CONNECTED_NAMES, type CatalogueEntry } from "./_catalogue";
import { UsageBar } from "./UsageBar";
import { IntegrationCard } from "./IntegrationCard";
import { DisconnectDialog } from "./DisconnectDialog";
import { GithubRepos } from "./GithubRepos";

interface EntitlementsResponse {
    integrations?: { used: number; limit: number; unlimited: boolean };
}

function ComposioCard({
    app,
    connecting,
    canConnect,
    canDelete,
    onConnect,
    onDisconnect,
}: {
    app: ComposioApp;
    connecting: string | null;
    canConnect: boolean;
    canDelete: boolean;
    onConnect: (app: ComposioApp) => void;
    onDisconnect: (app: ComposioApp) => void;
}) {
    return (
        <div className="rounded-xl border bg-card p-6 flex flex-col gap-4 transition-colors border-border">
            <div className="flex items-start justify-between">
                <div className="h-14 w-14 rounded-xl bg-muted flex items-center justify-center shrink-0 text-xl font-bold text-muted-foreground">
                    {app.label.charAt(0)}
                </div>
                {app.connected && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-500">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Connected
                    </span>
                )}
            </div>

            <div className="flex-1 space-y-1">
                <h3 className="font-semibold text-foreground text-sm">{app.label}</h3>
                <p className="text-xs text-muted-foreground">{app.description}</p>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {app.scopes.map((scope) => (
                    <span
                        key={scope}
                        className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
                    >
                        {scope}
                    </span>
                ))}
            </div>

            <div className="border-t border-border/50 pt-4 flex items-center justify-end">
                {app.connected ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDisconnect(app)}
                        disabled={!canDelete}
                    >
                        Disconnect
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        onClick={() => onConnect(app)}
                        disabled={connecting !== null || !canConnect}
                    >
                        {connecting === app.appName ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Connecting...
                            </>
                        ) : (
                            'Connect'
                        )}
                    </Button>
                )}
            </div>
        </div>
    );
}

export default function IntegrationsPage() {
    const { can } = usePermissions();
    const { tenantSlug } = useTenant();
    const searchParams = useSearchParams();
    const router = useRouter();
    const { isLoading, refetch, isConnected, getIntegration } = useIntegrations();
    const { apps: composioApps, isLoading: composioLoading, refetch: composioRefetch } = useComposioIntegrations();

    const { data: entData } = useQuery<EntitlementsResponse>({
        queryKey: ['entitlements', tenantSlug],
        queryFn: () => api.get<EntitlementsResponse>('/api/v1/entitlements'),
        staleTime: 60_000,
    });

    const intEnt = entData?.integrations;
    const connectedCount = CATALOGUE.filter(e => isConnected(e.provider)).length;
    const used = intEnt?.used ?? connectedCount;
    const limit = intEnt?.limit ?? 0;
    const unlimited = intEnt?.unlimited ?? false;
    const hasLimitData = unlimited || limit > 0;
    const atLimit = hasLimitData && !unlimited && used >= limit;
    const pct = hasLimitData && !unlimited ? Math.min((used / limit) * 100, 100) : 0;

    const [connecting, setConnecting] = useState<string | null>(null);
    const [disconnecting, setDisconnecting] = useState(false);
    const [disconnectTarget, setDisconnectTarget] = useState<CatalogueEntry | null>(null);

    const [composioConnecting, setComposioConnecting] = useState<string | null>(null);
    const [composioDisconnecting, setComposioDisconnecting] = useState(false);
    const [composioDisconnectTarget, setComposioDisconnectTarget] = useState<ComposioApp | null>(null);

    useEffect(() => {
        const connected = searchParams.get('connected');
        if (connected && CONNECTED_NAMES[connected]) {
            toast.success(`${CONNECTED_NAMES[connected]} connected!`);
            refetch();
            const url = new URL(window.location.href);
            url.searchParams.delete('connected');
            router.replace(url.pathname + url.search, { scroll: false });
        }
        const composioConnected = searchParams.get('composio_connected');
        if (composioConnected) {
            toast.success(`${composioConnected.charAt(0).toUpperCase() + composioConnected.slice(1)} connected!`);
            composioRefetch();
            const url = new URL(window.location.href);
            url.searchParams.delete('composio_connected');
            router.replace(url.pathname + url.search, { scroll: false });
        }
        const error = searchParams.get('error');
        if (error) {
            const messages: Record<string, string> = {
                google_denied:          'Google connection was cancelled.',
                state_expired:          'The OAuth session expired. Please try again.',
                token_exchange_failed:  'Failed to connect Google. Please try again.',
                configuration_error:    'OAuth is not configured. Contact support.',
                db_error:               'Failed to save connection. Please try again.',
            };
            toast.error(messages[error] ?? 'Connection failed. Please try again.');
            const url = new URL(window.location.href);
            url.searchParams.delete('error');
            router.replace(url.pathname + url.search, { scroll: false });
        }
    }, [searchParams]);

    const handleConnect = async (entry: CatalogueEntry) => {
        const connectUrl = CONNECT_URLS[entry.provider];
        if (!connectUrl) return;
        setConnecting(entry.provider);
        try {
            const { url } = await api.post<{ url: string }>(connectUrl);
            window.location.href = url;
        } catch {
            toast.error(`Failed to start ${entry.name} connection. Please try again.`);
            setConnecting(null);
        }
    };

    const handleDisconnectConfirm = async () => {
        if (!disconnectTarget) return;
        setDisconnecting(true);
        try {
            await api.del(`/api/v1/integrations/${disconnectTarget.provider}`);
            toast.success(`${disconnectTarget.name} disconnected`);
            refetch();
        } catch {
            toast.error(`Failed to disconnect ${disconnectTarget.name}.`);
        } finally {
            setDisconnecting(false);
            setDisconnectTarget(null);
        }
    };

    const handleComposioConnect = async (app: ComposioApp) => {
        setComposioConnecting(app.appName);
        try {
            const { url } = await api.post<{ url: string }>(`/api/v1/integrations/composio/${app.appName}/connect`);
            window.location.href = url;
        } catch {
            toast.error(`Failed to start ${app.label} connection. Please try again.`);
            setComposioConnecting(null);
        }
    };

    const handleComposioDisconnectConfirm = async () => {
        if (!composioDisconnectTarget) return;
        setComposioDisconnecting(true);
        try {
            await api.del(`/api/v1/integrations/composio/${composioDisconnectTarget.appName}`);
            toast.success(`${composioDisconnectTarget.label} disconnected`);
            composioRefetch();
        } catch {
            toast.error(`Failed to disconnect ${composioDisconnectTarget.label}.`);
        } finally {
            setComposioDisconnecting(false);
            setComposioDisconnectTarget(null);
        }
    };

    return (
        <PermissionGate resource="integrations" action="read">
            <div className="space-y-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Connectors</h1>
                    <p className="text-muted-foreground mt-2">
                        Connect your workspace with external tools and services.
                    </p>
                </div>

                {hasLimitData && (
                    <UsageBar
                        used={used}
                        limit={limit}
                        unlimited={unlimited}
                        atLimit={atLimit}
                        pct={pct}
                        billingHref={tenantSlug ? `/${tenantSlug}/dashboard/billing` : undefined}
                    />
                )}

                <div className="space-y-3">
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Native Integrations</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {isLoading
                            ? Array.from({ length: 5 }).map((_, i) => (
                                <Skeleton key={i} className="h-48 rounded-xl" />
                            ))
                            : CATALOGUE.map((entry) => (
                                <IntegrationCard
                                    key={entry.provider}
                                    entry={entry}
                                    connected={isConnected(entry.provider)}
                                    integration={getIntegration(entry.provider)}
                                    connecting={connecting}
                                    canConnect={can('integrations', 'create')}
                                    canDelete={can('integrations', 'delete')}
                                    onConnect={handleConnect}
                                    onDisconnect={setDisconnectTarget}
                                />
                            ))}
                    </div>
                </div>

                <div className="space-y-3">
                    <div>
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">AI Agent Tools</h2>
                        <p className="text-xs text-muted-foreground mt-1">Connected apps are available as tools in your AI agent conversations.</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {composioLoading
                            ? Array.from({ length: 6 }).map((_, i) => (
                                <Skeleton key={i} className="h-48 rounded-xl" />
                            ))
                            : composioApps.map((app) => (
                                <ComposioCard
                                    key={app.appName}
                                    app={app}
                                    connecting={composioConnecting}
                                    canConnect={can('integrations', 'create')}
                                    canDelete={can('integrations', 'delete')}
                                    onConnect={handleComposioConnect}
                                    onDisconnect={setComposioDisconnectTarget}
                                />
                            ))}
                    </div>
                </div>

                {isConnected('github') && <GithubRepos />}
            </div>

            <DisconnectDialog
                target={disconnectTarget}
                disconnecting={disconnecting}
                onOpenChange={(open) => !open && setDisconnectTarget(null)}
                onConfirm={handleDisconnectConfirm}
            />

            {composioDisconnectTarget && (
                <DisconnectDialog
                    target={{ provider: composioDisconnectTarget.appName, name: composioDisconnectTarget.label, description: composioDisconnectTarget.description, scopes: [...composioDisconnectTarget.scopes], icon: null, available: true }}
                    disconnecting={composioDisconnecting}
                    onOpenChange={(open) => !open && setComposioDisconnectTarget(null)}
                    onConfirm={handleComposioDisconnectConfirm}
                />
            )}
        </PermissionGate>
    );
}
