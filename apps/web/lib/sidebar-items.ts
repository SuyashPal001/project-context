import {
    LayoutDashboard,
    Users,
    Shield,
    CreditCard,
    Key,
    Bot,
    MessageSquare,
    Bell,
    FileText,
    Building2,
    Sliders,
    Webhook,
    FolderOpen,
    Plug,
    Palette,
    UserCircle,
    KanbanSquare,
    LayoutList,
    Database,
} from "lucide-react";
import React from 'react';

export interface SidebarItem {
    label: string;
    href: string;
    icon: React.ElementType;
    roles?: string[];
    planRequired?: 'starter' | 'business' | 'enterprise';
    planGateFeature?: string;
    locked?: boolean;
    showBusinessBadge?: boolean;
    sectionLabel?: string;
    isDivider?: boolean;
}

export function getSidebarItems(
    role: string,
    plan: string,
    tenantSlug: string,
    entitlements: Record<string, { enabled?: boolean; valueLimit?: number; unlimited?: boolean }> = {}
): SidebarItem[] {
    const base = `/${tenantSlug}/dashboard`;
    const isPlatformAdmin = role === 'platform_admin';
    const isAdminOrOwner = role === 'admin' || role === 'owner' || isPlatformAdmin;

    const brandingLocked     = entitlements['branding']?.enabled === false;
    const integrationsLocked = entitlements['mcp_integrations']?.enabled === false;
    const auditLocked        = entitlements['audit_log']?.enabled === false;
    const webhooksLocked     = entitlements['webhooks']?.enabled === false;
    const apiKeysLocked      = entitlements['api_keys_access']?.enabled === false;

    const items: SidebarItem[] = [];

    // 1. MAIN SECTION — all users
    items.push({ label: "Chat", href: `${base}/chat`, icon: MessageSquare });
    items.push({ label: "Agents", href: `${base}/agents`, icon: Bot });
    items.push({ label: "Board", href: `${base}/board`, icon: KanbanSquare });
    items.push({ label: "Projects", href: `${base}/plans`, icon: LayoutList });
    items.push({ label: "Documents", href: `${base}/files`, icon: FolderOpen });
    items.push({ label: "Datasource", href: `${base}/lakehouse`, icon: Database });

    items.push({ isDivider: true, href: '', icon: () => null, label: '' });

    items.push({ label: "Notifications", href: `${base}/notifications`, icon: Bell });

    // Audit log — admin/owner only (platform management)
    if (isAdminOrOwner) {
        items.push({
            label: "Audit log",
            href: `${base}/audit`,
            icon: FileText,
            planRequired: 'business',
            planGateFeature: 'audit_log',
            locked: auditLocked,
        });
    }

    // 2. SETTINGS SECTION — all users
    items.push({ label: "Profile", href: `${base}/settings/profile`, icon: UserCircle, sectionLabel: "Settings" });
    items.push({ label: "Workspace", href: `${base}/settings/workspace`, icon: Building2 });

    // Admin/Owner only — platform management
    if (isAdminOrOwner) {
        items.push({ label: "Connectors", href: `${base}/integrations`, icon: Plug });
        items.push({ label: "Members", href: `${base}/settings/members`, icon: Users });
        items.push({ label: "Roles", href: `${base}/settings/roles`, icon: Shield });
        items.push({ label: "Billing", href: `${base}/billing`, icon: CreditCard });
        items.push({
            label: "Branding",
            href: `${base}/branding`,
            icon: Palette,
            planRequired: 'starter',
            planGateFeature: 'branding',
            locked: brandingLocked,
        });

        // 3. DEVELOPER SECTION — admin/owner only
        items.push({
            label: "API keys",
            href: `${base}/api-keys`,
            icon: Key,
            sectionLabel: "Developer settings",
            planRequired: 'starter',
            planGateFeature: 'api_keys_access',
            locked: apiKeysLocked,
        });
        items.push({
            label: "Webhooks",
            href: `${base}/webhooks`,
            icon: Webhook,
            planRequired: 'starter',
            planGateFeature: 'webhooks',
            locked: webhooksLocked,
        });
        items.push({
            label: "Integrations",
            href: `${base}/custom-integrations`,
            icon: Sliders,
            planRequired: 'business',
            planGateFeature: 'mcp_integrations',
            locked: integrationsLocked,
        });
    }

    // 4. OPS PORTAL (Platform Admin Only) — standalone route, no tenant slug
    if (isPlatformAdmin) {
        items.push({
            label: "Ops Portal",
            href: "/ops/tenants",
            icon: Building2,
            sectionLabel: "Admin"
        });
    }

    return items;
}
