"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { api } from "@/lib/api";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useTenant } from "@/app/[tenant]/tenant-provider";

import { CATALOGUE, GOVT_CATALOGUE, CONNECT_URLS, CONNECTED_NAMES, type CatalogueEntry } from "./_catalogue";
import { UsageBar } from "./UsageBar";
import { IntegrationCard } from "./IntegrationCard";
import { DisconnectDialog } from "./DisconnectDialog";
import { GithubRepos } from "./GithubRepos";

interface EntitlementsResponse {
    integrations?: { used: number; limit: number; unlimited: boolean };
}

export default function IntegrationsPage() {
    const { can } = usePermissions();
    const { tenantSlug } = useTenant();
    const searchParams = useSearchParams();
    const router = useRouter();
    const { isLoading, refetch, isConnected, getIntegration } = useIntegrations();

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

    // Detect ?connected=<service> after OAuth callback redirect
    useEffect(() => {
        const connected = searchParams.get('connected');
        if (connected && CONNECTED_NAMES[connected]) {
            toast.success(`${CONNECTED_NAMES[connected]} connected!`);
            refetch();
            const url = new URL(window.location.href);
            url.searchParams.delete('connected');
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

    return (
        <PermissionGate resource="integrations" action="read">
            <div className="space-y-6">
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

                {isConnected('github') && <GithubRepos />}

                {/* Government Systems — requires approval */}
                <div className="pt-4">
                    <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-lg font-semibold tracking-tight">Government Systems</h2>
                        <span className="text-xs px-2 py-0.5 rounded-sm border font-medium"
                            style={{ color: '#fbbf24', borderColor: 'rgba(251,191,36,0.3)', background: 'rgba(251,191,36,0.08)' }}>
                            Requires NIC Approval
                        </span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-5">
                        These integrations require approval from NIC before they can be activated.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {GOVT_CATALOGUE.map((entry) => (
                            <IntegrationCard
                                key={entry.provider}
                                entry={entry}
                                connected={false}
                                integration={undefined}
                                connecting={null}
                                canConnect={false}
                                canDelete={false}
                                onConnect={() => {}}
                                onDisconnect={() => {}}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <DisconnectDialog
                target={disconnectTarget}
                disconnecting={disconnecting}
                onOpenChange={(open) => !open && setDisconnectTarget(null)}
                onConfirm={handleDisconnectConfirm}
            />
        </PermissionGate>
    );
}
