import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { decodeTenantClaims } from "@/lib/tenant";
import { TenantProvider } from "./tenant-provider";
import { UpgradePromptProvider } from "@/components/platform/UpgradePromptProvider";
import { PostHogIdentifier } from "@/components/posthog-identifier";
import { Agent, fetch as undiciFetch } from 'undici';

export default async function TenantLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ tenant: string }>;
}) {
    const { tenant } = await params;

    // Await Next.js 15 cookies and headers
    const cookieStore = await cookies();
    const token = cookieStore.get("platform_token")?.value;

    if (!token) {
        redirect("/auth/login");
    }

    const claims = decodeTenantClaims(token);
    if (claims) {
        claims.tenantSlug = tenant;
    }

    if (!claims) {
        redirect("/auth/login");
    }

    if (claims.role === "platform_admin") {
        redirect("/ops");
    }

    // Fetch permissions from API server-side
    try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL;
        const agent = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
        const response = await undiciFetch(`${apiBase}/api/v1/auth/me`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
            dispatcher: agent,
        });

        if (response.ok) {
            const profile = await response.json() as any;
            claims.permissions = profile.permissions || [];
            if (profile.userId) claims.userId = profile.userId;
        } else {
            // On failure, set empty array and continue
            claims.permissions = [];
        }
    } catch (error) {
        console.error('Failed to fetch permissions:', error);
        // On failure, set empty array and continue (don't block the page)
        claims.permissions = [];
    }

    // Fetch entitlements server-side for sidebar plan-gating
    try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL;
        const agent2 = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
        const entResponse = await undiciFetch(`${apiBase}/api/v1/entitlements`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
            dispatcher: agent2,
        });

        if (entResponse.ok) {
            const entData = await entResponse.json() as any;
            claims.entitlementFeatures = entData.features || {};
        } else {
            claims.entitlementFeatures = {};
        }
    } catch (error) {
        console.error('Failed to fetch entitlements:', error);
        claims.entitlementFeatures = {};
    }

    return (
        <TenantProvider claims={claims}>
            <PostHogIdentifier />
            <UpgradePromptProvider>
                <div className="tenant-context-wrapper" data-tenant={tenant}>
                    {children}
                </div>
            </UpgradePromptProvider>
        </TenantProvider>
    );
}
