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
    Bell,
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
    LogOut
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { useNotifications } from "@/lib/notifications-context"
import { useSidebar } from "./SidebarContext"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getSidebarItems, getDeveloperPanelItems, type SidebarItem as SidebarItemType } from "@/lib/sidebar-items"
import { signOut } from "@/lib/auth"
import { UsageBar } from "./UsageBar"
import { SaarthiLogo } from "./SaarthiLogo"


interface SidebarNavLinkProps {
    item: SidebarItemType
    isCollapsed?: boolean
    unreadCount?: number
    onLockedClick?: () => void
}

function SidebarNavLink({ item, isCollapsed, unreadCount, onLockedClick }: SidebarNavLinkProps) {
    const pathname = usePathname()
    const isActive = pathname === item.href
    const Icon = item.icon

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
                }
            }}
        >
            <Icon className="w-4 h-4 shrink-0" />
            
            {!isCollapsed && (
                <div className="flex items-center justify-between flex-1 min-w-0">
                    <span className="truncate">{item.label}</span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {item.showBusinessBadge && (
                            <Badge variant="outline" className="h-4 px-1 text-[8px] font-bold uppercase tracking-tighter bg-purple-500/10 text-purple-500 border-purple-500/20">
                                business
                            </Badge>
                        )}
                        {item.locked && <Lock className="w-3 h-3 text-muted-foreground" />}
                        {item.label === "Notifications" && unreadCount !== undefined && unreadCount > 0 && (
                            <span className="bg-primary text-primary-foreground rounded-full text-[10px] h-4 w-4 flex items-center justify-center font-bold">
                                {unreadCount > 9 ? "9+" : unreadCount}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {isCollapsed && item.label === "Notifications" && unreadCount !== undefined && unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground rounded-full text-[10px] h-4 w-4 flex items-center justify-center font-bold border-2 border-card">
                    {unreadCount > 9 ? "9+" : unreadCount}
                </span>
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
    const { tenantSlug, role, plan, name, email, entitlementFeatures = {} } = useTenant()
    const { unreadCount } = useNotifications()
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

    const handleLockedClick = (item: SidebarItemType) => {
        window.dispatchEvent(new CustomEvent('plan-gate', {
            detail: {
                feature: item.planGateFeature || '',
                requiredPlan: item.planRequired
                    ? item.planRequired.charAt(0).toUpperCase() + item.planRequired.slice(1)
                    : 'Starter',
            }
        }))
    }

    const getInitials = () => {
        if (name) return name.split(' ').map((n: string) => n[0]).join('').toUpperCase()
        if (email) return email[0].toUpperCase()
        return "US"
    }

    const getAvatarBg = () => {
        if (role === 'platform_admin') return "bg-[#ff7f50]" // Coral
        if (role === 'member') return "bg-blue-500"
        return "bg-zinc-500" // Admin/Owner default
    }

    return (
        <TooltipProvider>
            <aside className={cn(
                "fixed left-0 top-0 bottom-0 flex flex-col bg-card border-r border-border py-6 z-50 transition-all duration-300 ease-in-out",
                isSidebarCollapsed ? "w-16 px-2" : "w-60 px-4"
            )}>
                {/* Logo Section */}
                <div className={cn(
                    "flex items-center mb-8 px-2 transition-all duration-300",
                    isSidebarCollapsed ? "justify-center" : ""
                )}>
                    <SaarthiLogo
                        variant={isSidebarCollapsed ? "icon" : "full"}
                        iconSize={isSidebarCollapsed ? 30 : 28}
                    />
                </div>

                {/* Navigation Items */}
                <nav className="flex-1 space-y-1 overflow-y-auto custom-scrollbar pr-1 -mr-1">
                    {isDeveloperPanelActive ? (
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
                                        Developers
                                    </TooltipContent>
                                </Tooltip>
                            ) : (
                                <Link
                                    href={`/${tenantSlug}/dashboard/chat`}
                                    className="flex items-center gap-3 px-3 py-2 mb-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground transition-all"
                                >
                                    <ChevronLeft className="w-4 h-4 shrink-0" />
                                    <span>Developers</span>
                                </Link>
                            )}
                            {developerPanelItems.map((item) => (
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
                                        unreadCount={item.label === "Notifications" ? unreadCount : undefined}
                                        onLockedClick={() => handleLockedClick(item)}
                                    />
                                </React.Fragment>
                            )
                        })
                    )}
                </nav>

                {/* Messages usage — hidden when collapsed */}
                {!isSidebarCollapsed && <UsageBar />}

                {/* Footer Section */}
                <div className="mt-auto pt-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleSidebar}
                        className="w-full h-10 rounded-md hover:bg-accent hover:text-accent-foreground transition-all group"
                    >
                        {isSidebarCollapsed ? (
                            <PanelLeftOpen className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
                        ) : (
                            <div className="flex items-center gap-3 w-full px-3">
                                <PanelLeftClose className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
                                <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">Collapse</span>
                            </div>
                        )}
                    </Button>
                </div>
            </aside>

        </TooltipProvider>
    )
}