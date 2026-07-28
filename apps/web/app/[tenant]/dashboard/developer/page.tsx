import { DeveloperOverviewCards } from "@/components/platform/developer/DeveloperOverviewCards";
import { PermissionGate } from "@/components/platform/PermissionGate";

export default async function DeveloperOverviewPage({
    params,
}: {
    params: Promise<{ tenant: string }>;
}) {
    await params;

    return (
        <PermissionGate resource="api_keys" action="read">
            <div className="space-y-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">
                        Developers
                    </h1>
                    <p className="text-muted-foreground mt-2">
                        Manage API keys, webhooks, and connections for your workspace.
                    </p>
                </div>

                <DeveloperOverviewCards />
            </div>
        </PermissionGate>
    );
}
