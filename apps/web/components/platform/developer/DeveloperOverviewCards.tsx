"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { useIntegrations } from "@/hooks/useIntegrations";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Key, Webhook, Sliders, AlertCircle, type LucideIcon } from "lucide-react";

interface ApiKeySummary {
    status: "active" | "revoked";
}

interface ApiKeysResponse {
    data: ApiKeySummary[];
}

interface WebhooksResponse {
    data: unknown[];
}

function OverviewCard({
    href,
    icon: Icon,
    title,
    isLoading,
    isError,
    value,
    description,
}: {
    href: string;
    icon: LucideIcon;
    title: string;
    isLoading: boolean;
    isError: boolean;
    value: string;
    description: string;
}) {
    return (
        <Link href={href}>
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader>
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Icon className="w-4 h-4" />
                        <CardTitle className="text-sm font-medium">{title}</CardTitle>
                    </div>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <Skeleton className="h-8 w-16" />
                    ) : isError ? (
                        <div className="flex items-center gap-1.5 text-destructive">
                            <AlertCircle className="w-4 h-4" />
                            <p className="text-sm font-medium">Failed to load</p>
                        </div>
                    ) : (
                        <p className="text-3xl font-bold tracking-tight text-foreground">{value}</p>
                    )}
                    <p className="text-sm text-muted-foreground mt-1">{description}</p>
                </CardContent>
            </Card>
        </Link>
    );
}

export function DeveloperOverviewCards() {
    const { tenantId, tenantSlug } = useTenant();
    const base = `/${tenantSlug}/dashboard`;

    const { data: apiKeysData, isLoading: apiKeysLoading, isError: apiKeysError } = useQuery<ApiKeysResponse>({
        queryKey: ["api-keys", tenantId],
        queryFn: () => api.get<ApiKeysResponse>("/api/v1/api-keys"),
    });

    const { data: webhooksData, isLoading: webhooksLoading, isError: webhooksError } = useQuery<WebhooksResponse>({
        queryKey: ["webhooks"],
        queryFn: () => api.get<WebhooksResponse>("/api/v1/webhooks"),
    });

    const { integrations, isLoading: integrationsLoading, isError: integrationsError } = useIntegrations();

    const activeKeyCount = (apiKeysData?.data ?? []).filter((k) => k.status === "active").length;
    const webhookCount = (webhooksData?.data ?? []).length;
    const activeConnectionCount = integrations.filter((i) => i.status === "active").length;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <PermissionGate resource="api_keys" action="read" fallback={null}>
                <OverviewCard
                    href={`${base}/api-keys`}
                    icon={Key}
                    title="API keys"
                    isLoading={apiKeysLoading}
                    isError={apiKeysError}
                    value={String(activeKeyCount)}
                    description="Active keys"
                />
            </PermissionGate>
            <PermissionGate resource="webhooks" action="read" fallback={null}>
                <OverviewCard
                    href={`${base}/webhooks`}
                    icon={Webhook}
                    title="Webhooks"
                    isLoading={webhooksLoading}
                    isError={webhooksError}
                    value={String(webhookCount)}
                    description="Configured endpoints"
                />
            </PermissionGate>
            <PermissionGate resource="integrations" action="read" fallback={null}>
                <OverviewCard
                    href={`${base}/custom-integrations`}
                    icon={Sliders}
                    title="Connections"
                    isLoading={integrationsLoading}
                    isError={integrationsError}
                    value={String(activeConnectionCount)}
                    description="Active connections"
                />
            </PermissionGate>
        </div>
    );
}
