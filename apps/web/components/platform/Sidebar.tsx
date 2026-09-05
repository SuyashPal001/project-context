"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
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
    Plug,
    Lock,
    ChevronRight,
    ChevronLeft,
    PanelLeftClose,
    PanelLeftOpen,
    LogOut,
    Brain
} from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { PLANS } from "./billing/PlanSelectorDialog"
import { NotificationsBell } from "./notifications/NotificationsBell"
import { useSidebar } from "./SidebarContext"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { getSidebarItems, getDeveloperPanelItems, getSettingsPanelItems, type SidebarItem as SidebarItemType } from "@/lib/sidebar-items"
import { signOut } from "@/lib/auth"
import { WorkspaceSwitcherPill } from "./WorkspaceSwitcherPill"
import { AccountMenu } from "./AccountMenu"


interface SidebarNavLinkProps {
    item: SidebarItemType
    isCollapsed?: boolean
    onLockedClick?: () => void
    badgeCount?: number
}

function SidebarNavLink({ item, isCollapsed, onLockedClick, badgeCount }: SidebarNavLinkProps) {
    const pathname = usePathname()
    const isActive = pathname === item.href
    const Icon = item.icon
    const { collapseSidebar } = useSidebar()
    // Chat's own message list + pane need the room; every other nav
    // destination keeps whatever collapse state the user already chose.
    const isChatLink = item.label === "Chat"

    const content = (
        <div
            className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all group relative",
                item.locked ? "opacity-50 cursor-pointer" : "cursor-pointer",
                isActive && !item.locked
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                isCollapsed && "justify-center px-2"
            )}
            onClick={(e) => {
                if (item.locked) {
                    e.preventDefault()
                    onLockedClick?.()
                    return
                }
                if (isChatLink) collapseSidebar()
            }}
        >
            <span className="relative shrink-0">
                <Icon className="w-4 h-4" />
                {!!badgeCount && isCollapsed && (
                    <span className="absolute -top-1.5 -right-1.5 bg-primary text-primary-foreground rounded-full text-[9px] h-3.5 min-w-3.5 px-0.5 flex items-center justify-center font-bold">
                        {badgeCount > 9 ? "9+" : badgeCount}
                    </span>
                )}
            </span>

            {!isCollapsed && (
                <div className="flex items-center justify-between flex-1 min-w-0">
                    <span className="truncate">{item.label}</span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {item.showBusinessBadge && (
                            <Badge variant="outline" className="h-4 px-1 text-[8px] font-bold uppercase tracking-tighter bg-primary/10 text-primary border-primary/20">
                                business
                            </Badge>
                        )}
                        {!!badgeCount && (
                            <Badge className="h-4 min-w-4 px-1 text-[9px] font-bold bg-primary text-primary-foreground border-transparent">
                                {badgeCount > 9 ? "9+" : badgeCount}
                            </Badge>
                        )}
                        {item.locked && <Lock className="w-3 h-3 text-muted-foreground" />}
                    </div>
                </div>
            )}
        </div>
    )

    if (item.locked) {
        return (
            <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                    {content}
                </TooltipTrigger>
                <TooltipContent side="right" className="ml-2 font-medium">
                    {isCollapsed
                        ? `${item.label} (Locked)`
                        : `Upgrade to ${item.planRequired ? item.planRequired.charAt(0).toUpperCase() + item.planRequired.slice(1) : 'a higher plan'} to unlock`}
                </TooltipContent>
            </Tooltip>
        )
    }

    if (isCollapsed) {
        return (
            <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                    <Link href={item.href}>{content}</Link>
                </TooltipTrigger>
                <TooltipContent side="right" className="ml-2">
                    {item.label}
                </TooltipContent>
            </Tooltip>
        )
    }

    return <Link href={item.href}>{content}</Link>
}

export function Sidebar() {
    const { tenantSlug, role, plan, entitlementFeatures = {} } = useTenant()

    const { data: branding } = useQuery({
        queryKey: ["branding"],
        queryFn: async () => {
            const res = await api.get<{ data: { brandName: string | null; logoUrl: string | null } }>("/api/v1/branding")
            return res.data
        },
        staleTime: 5 * 60 * 1000,
    })
    const brandName = branding?.brandName || "OlmoWorks"
    const brandLogoUrl = branding?.logoUrl
    const { isSidebarCollapsed, toggleSidebar } = useSidebar()
    const pathname = usePathname()

    const entitlements = Object.fromEntries(
        Object.entries(entitlementFeatures).map(([k, v]) => [k, { enabled: v as boolean }])
    )
    const sidebarItems = getSidebarItems(role, plan, tenantSlug || '', entitlements)
    const developerPanelItems = getDeveloperPanelItems(tenantSlug || '', entitlements)

    const developerRoutePrefixes = [
        `/${tenantSlug || ''}/dashboard/developer`,
        `/${tenantSlug || ''}/dashboard/api-keys`,
        `/${tenantSlug || ''}/dashboard/webhooks`,
        `/${tenantSlug || ''}/dashboard/custom-integrations`,
    ]
    const isAdminOrOwner = role === 'admin' || role === 'owner' || role === 'platform_admin'
    const isDeveloperPanelActive = isAdminOrOwner && developerRoutePrefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )

    const settingsPanelItems = getSettingsPanelItems(role, tenantSlug || '', entitlements)

    // /settings/profile is intentionally absent: it is reached from the avatar
    // menu, and matching it here would swap the nav on a page the panel omits.
    const settingsRoutePrefixes = [
        `/${tenantSlug || ''}/dashboard/settings/workspace`,
        `/${tenantSlug || ''}/dashboard/settings/members`,
        `/${tenantSlug || ''}/dashboard/settings/roles`,
        `/${tenantSlug || ''}/dashboard/integrations`,
        `/${tenantSlug || ''}/dashboard/billing`,
        `/${tenantSlug || ''}/dashboard/branding`,
        `/${tenantSlug || ''}/dashboard/audit`,
    ]
    const isSettingsPanelActive = !isDeveloperPanelActive && settingsRoutePrefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )

    // Whichever nested panel the current route belongs to, or null for main nav.
    const activePanel = isDeveloperPanelActive
        ? { label: 'Developers', items: developerPanelItems }
        : isSettingsPanelActive
            ? { label: 'Settings', items: settingsPanelItems }
            : null

    const handleLockedClick = (item: SidebarItemType) => {
        window.dispatchEvent(new CustomEvent('plan-gate', {
            detail: {
                feature: item.planGateFeature || '',
                requiredPlan: item.planRequired
                    ? (PLANS.find(p => p.id === item.planRequired)?.name ?? item.planRequired)
                    : PLANS.find(p => p.id === 'starter')!.name,
            }
        }))
    }

    return (
        <TooltipProvider>
            <aside id="app-sidebar" className={cn(
                "fixed left-0 top-0 bottom-0 flex flex-col bg-card border-r border-border py-6 z-50 transition-all duration-300 ease-in-out",
                isSidebarCollapsed ? "w-16 px-2" : "w-[17rem] px-4"
            )}>
                {/* Brand row */}
                <div className={cn(
                    "flex items-center mb-3",
                    isSidebarCollapsed ? "flex-col gap-1" : "justify-between px-0.5"
                )}>
                    {!isSidebarCollapsed && (
                        <Link
                            href={`/${tenantSlug || ''}/dashboard/chat`}
                            className="flex items-center gap-2 min-w-0 rounded-md hover:bg-accent/50 transition-colors -mx-1 px-1 py-0.5"
                        >
                            {brandLogoUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={brandLogoUrl}
                                    alt={brandName}
                                    className="shrink-0 h-7 w-7 rounded-lg object-cover"
                                />
                            ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src="/brand/olmoworks-mark.svg"
                                    alt={brandName}
                                    className="shrink-0 object-contain"
                                    style={{ height: 24, width: "auto" }}
                                />
                            )}
                            <span className="text-base font-semibold text-foreground tracking-tight truncate">{brandName}</span>
                        </Link>
                    )}
                    <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                            <button
                                onClick={toggleSidebar}
                                className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                            >
                                {isSidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side={isSidebarCollapsed ? "right" : "bottom"} className="ml-1">
                            {isSidebarCollapsed ? "Expand" : "Collapse"}
                        </TooltipContent>
                    </Tooltip>
                </div>

                {/* Workspace switcher */}
                <div className="mb-6">
                    <WorkspaceSwitcherPill collapsed={isSidebarCollapsed} />
                </div>

                {/* Navigation Items */}
                <nav className="flex-1 space-y-1 overflow-y-auto custom-scrollbar pr-1 -mr-1">
                    {activePanel ? (
                        <>
                            {isSidebarCollapsed ? (
                                <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                        <Link
                                            href={`/${tenantSlug}/dashboard/chat`}
                                            className={cn(
                                                "flex items-center gap-3 px-3 py-2 mb-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground transition-all",
                                                "justify-center px-2"
                                            )}
                                        >
                                            <ChevronLeft className="w-4 h-4 shrink-0" />
                                        </Link>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="ml-2">
                                        {activePanel.label}
                                    </TooltipContent>
                                </Tooltip>
                            ) : (
                                <Link
                                    href={`/${tenantSlug}/dashboard/chat`}
                                    className="flex items-center gap-3 px-3 py-2 mb-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground transition-all"
                                >
                                    <ChevronLeft className="w-4 h-4 shrink-0" />
                                    <span>{activePanel.label}</span>
                                </Link>
                            )}
                            {activePanel.items.map((item) => (
                                <SidebarNavLink
                                    key={item.href}
                                    item={item}
                                    isCollapsed={isSidebarCollapsed}
                                    onLockedClick={() => handleLockedClick(item)}
                                />
                            ))}
                        </>
                    ) : (
                        sidebarItems.map((item, index) => {
                            if (item.isDivider) {
                                return !isSidebarCollapsed && (
                                    <div key={`divider-${index}`} className="my-4 px-3">
                                        <div className="h-px bg-border/50 w-full" />
                                    </div>
                                )
                            }

                            return (
                                <React.Fragment key={item.href || `section-${index}`}>
                                    {item.sectionLabel && !isSidebarCollapsed && (
                                        <p className="px-3 mt-6 mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 font-mono">
                                            {item.sectionLabel}
                                        </p>
                                    )}
                                    <SidebarNavLink
                                        item={item}
                                        isCollapsed={isSidebarCollapsed}
                                        onLockedClick={() => handleLockedClick(item)}
                                    />
                                </React.Fragment>
                            )
                        })
                    )}
                </nav>

                {/* Credit balance used to render here as its own row. Removed —
                    the account dropdown's Credits row (AccountMenu.tsx) already
                    covers it, and reveals the same usage breakdown on click, so
                    this was a redundant second reading of the same balance. */}

                {/* Footer Section — account (opens a menu) and notifications
                    (opens a feed) are different objects, so they get
                    different triggers rather than one absorbing the other.
                    AccountMenu renders the bell itself (beside its trigger
                    row, not beside the Upgrade CTA above it) so the two stay
                    vertically aligned regardless of whether that CTA shows.
                    Collapsed: stacked, both icon-only. */}
                <div className="mt-auto pt-4 border-t border-border">
                    {isSidebarCollapsed && <NotificationsBell collapsed />}
                    <AccountMenu collapsed={isSidebarCollapsed} />
                </div>
            </aside>

        </TooltipProvider>
    )
}