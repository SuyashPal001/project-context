import {
    LayoutDashboard,
    Users,
    Shield,
    CreditCard,
    Key,
    Bot,
    MessageSquare,
    FileText,
    Building2,
    Sliders,
    Webhook,
    FolderOpen,
    Puzzle,
    Plug,
    Palette,
    KanbanSquare,
    LayoutList,
    Code2,
    Settings,
    Bell,

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

import { FEATURE_FLAGS } from './feature-flags';

export function getSidebarItems(
    role: string,
    plan: string,
    tenantSlug: string,
    entitlements: Record<string, { enabled?: boolean; valueLimit?: number; unlimited?: boolean }> = {}
): SidebarItem[] {
    const base = `/${tenantSlug}/dashboard`;
    const isPlatformAdmin = role === 'platform_admin';
    const isAdminOrOwner = role === 'admin' || role === 'owner' || isPlatformAdmin;

    const auditLocked        = entitlements['audit_log']?.enabled === false;

    const items: SidebarItem[] = [];

    // 1. MAIN SECTION — all users
    items.push({ label: "Chat", href: `${base}/chat`, icon: MessageSquare });
    items.push({ label: "Employees", href: `${base}/agents`, icon: Bot });
    if (FEATURE_FLAGS.board) items.push({ label: "Board", href: `${base}/board`, icon: KanbanSquare });
    if (FEATURE_FLAGS.plans) items.push({ label: "Projects", href: `${base}/plans`, icon: LayoutList });
    items.push({ label: "Drive", href: `${base}/drive`, icon: FolderOpen });
    items.push({ label: "Skills", href: `${base}/skills`, icon: Puzzle });
    items.push({ label: "Notifications", href: `${base}/notifications`, icon: Bell });


    items.push({ isDivider: true, href: '', icon: () => null, label: '' });

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

    // 2. SETTINGS — collapses into a nested panel (see getSettingsPanelItems).
    // Profile deliberately omitted: it is reachable from the avatar menu in
    // Topbar.tsx, which targets the same /settings/profile route.
    items.push({ label: "Settings", href: `${base}/settings/workspace`, icon: Settings, sectionLabel: "Settings" });

    // 3. DEVELOPER SECTION — admin/owner only
    if (isAdminOrOwner) {
        items.push({
            label: "Developers",
            href: `${base}/developer`,
            icon: Code2,
            sectionLabel: "Developer settings",
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

export function getSettingsPanelItems(
    role: string,
    tenantSlug: string,
    entitlements: Record<string, { enabled?: boolean; valueLimit?: number; unlimited?: boolean }> = {}
): SidebarItem[] {
    const base = `/${tenantSlug}/dashboard`;
    const isAdminOrOwner = role === 'admin' || role === 'owner' || role === 'platform_admin';

    const brandingLocked = entitlements['branding']?.enabled === false;

    // Workspace is visible to every role — matches the pre-panel behaviour.
    const items: SidebarItem[] = [
        { label: "Workspace", href: `${base}/settings/workspace`, icon: Building2 },
    ];

    // Everything below was admin/owner-only before the panel existed. Keep it
    // that way, or members see settings pages they cannot use.
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
    }

    return items;
}

export function getDeveloperPanelItems(
    tenantSlug: string,
    entitlements: Record<string, { enabled?: boolean; valueLimit?: number; unlimited?: boolean }> = {}
): SidebarItem[] {
    const base = `/${tenantSlug}/dashboard`;

    const apiKeysLocked      = entitlements['api_keys_access']?.enabled === false;
    const webhooksLocked     = entitlements['webhooks']?.enabled === false;
    const integrationsLocked = entitlements['mcp_integrations']?.enabled === false;

    return [
        { label: "Overview", href: `${base}/developer`, icon: LayoutDashboard },
        {
            label: "API keys",
            href: `${base}/api-keys`,
            icon: Key,
            planRequired: 'starter',
            planGateFeature: 'api_keys_access',
            locked: apiKeysLocked,
        },
        {
            label: "Webhooks",
            href: `${base}/webhooks`,
            icon: Webhook,
            planRequired: 'starter',
            planGateFeature: 'webhooks',
            locked: webhooksLocked,
        },
        {
            label: "Connections",
            href: `${base}/custom-integrations`,
            icon: Sliders,
            planRequired: 'business',
            planGateFeature: 'mcp_integrations',
            locked: integrationsLocked,
        },
    ];
}
