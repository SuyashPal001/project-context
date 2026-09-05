"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { User, LogOut, ChevronsUpDown, Sun, Moon, Monitor, Zap, HelpCircle, Settings, Code2 } from "lucide-react"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { signOut } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { useCreditBalance, microToCredits } from "@/lib/hooks/useCredits"
import { PLANS } from "@/components/platform/billing/PlanSelectorDialog"
import { NotificationsBell } from "@/components/platform/notifications/NotificationsBell"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"

const THEME_OPTIONS = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
] as const

export function AccountMenu({ collapsed }: { collapsed?: boolean }) {
    const router = useRouter()
    const { tenantSlug, plan, email, name, role } = useTenant()
    const { theme, setTheme } = useTheme()
    const [isOpen, setIsOpen] = React.useState(false)
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => setMounted(true), [])

    const getInitials = () => {
        if (name) return name.split(' ').map((n: string) => n[0]).join('').toUpperCase()
        if (email) return email[0].toUpperCase()
        return "US"
    }

    const getAvatarBg = () => {
        if (role === 'platform_admin') return "bg-[#ff7f50]" // Coral
        if (role === 'member') return "bg-blue-500"
        return "bg-[#3A3B42]" // Admin/Owner default — graphite, not pure black
    }

    const currentThemeIcon = mounted ? (THEME_OPTIONS.find(o => o.value === theme)?.icon ?? Monitor) : Monitor
    const CurrentThemeIcon = currentThemeIcon

    const isAdminOrOwner = role === 'admin' || role === 'owner' || role === 'platform_admin'

    const planIndex = PLANS.findIndex(p => p.id === (plan?.toLowerCase() || 'free'))
    const nextPlan = planIndex >= 0 && planIndex < PLANS.length - 1 ? PLANS[planIndex + 1] : null
    const currentPlanName = planIndex >= 0 ? PLANS[planIndex].name : (plan || "Free")

    // Was a `messages` quota read off /entitlements. That feature was retired
    // when credits replaced it, so the figure enforced nothing — it just sat
    // under the plan name looking like a limit. Same hook the sidebar's
    // CreditBalanceIndicator uses, so the two never disagree and it shares a
    // cache rather than issuing its own request.
    const { data: credits } = useCreditBalance()

    return (
        <div className="w-full">
            {/* Standalone CTA above the profile row, not just inside the dropdown —
                hidden once collapsed (no room) or already on the top plan. */}
            {!collapsed && nextPlan && (
                <Link
                    href={`/${tenantSlug}/dashboard/billing`}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-[#E69DB8] to-[#F2A679] px-3 py-2 text-[13px] font-semibold text-black shadow-sm hover:opacity-90 transition-opacity"
                >
                    <Zap className="h-3.5 w-3.5 fill-black shrink-0" />
                    Upgrade to {nextPlan.name}
                </Link>
            )}
        <div className="flex items-center gap-1">
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger className={cn("focus:outline-none", collapsed ? "w-full" : "flex-1 min-w-0")}>
                <div className={cn(
                    "flex items-center gap-3 rounded-lg transition-all hover:bg-accent/50 group w-full",
                    collapsed ? "justify-center px-2 py-2" : "px-2.5 py-2"
                )}>
                    <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-border shadow-sm overflow-hidden",
                        getAvatarBg()
                    )}>
                        <span className="text-xs font-bold text-white">
                            {getInitials()}
                        </span>
                    </div>
                    {!collapsed && (
                        <>
                            <div className="flex flex-col min-w-0 text-left flex-1">
                                <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground truncate leading-none mb-1">
                                    <span className="truncate">{name || "User"}</span>
                                    <span className="shrink-0 text-[9px] font-bold tracking-wide text-muted-foreground/70 uppercase">
                                        {currentPlanName}
                                    </span>
                                </p>
                                <p className="text-[11px] text-muted-foreground truncate leading-none">
                                    {email || "user@platform.com"}
                                </p>
                            </div>
                            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        </>
                    )}
                </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                side={collapsed ? "right" : "top"}
                className={cn(
                    "p-2.5 rounded-2xl bg-card border-border/50 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28),0_8px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.65),0_10px_28px_-8px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgba(255,255,255,0.05)]",
                    // Expanded: match the sidebar's inner content width (272px column
                    // minus its 16px×2 padding) directly, not the trigger's own
                    // rendered width — the trigger now shares its row with the
                    // notifications bell, so `--radix-dropdown-menu-trigger-width`
                    // would be trigger-minus-bell-width, narrower than the sidebar.
                    // Collapsed: the trigger is a small icon button, so neither width
                    // fits — keep a fixed size and float it off to the side instead.
                    collapsed ? "w-[272px]" : "w-60",
                )}
            >
                {/* Header Block - Non-clickable */}
                <div className="flex items-center gap-3 px-1.5 pb-2.5">
                    <div className={cn(
                        "w-9 h-9 rounded-full flex items-center justify-center shrink-0 border border-border shadow-sm overflow-hidden",
                        getAvatarBg()
                    )}>
                        <span className="text-xs font-bold text-white">{getInitials()}</span>
                    </div>
                    <div className="flex flex-col min-w-0">
                        <p className="text-[13px] font-medium text-foreground truncate">{name || "User"}</p>
                        <p className="text-[12px] text-muted-foreground truncate">
                            {email || "user@platform.com"}
                        </p>
                    </div>
                </div>

                {/* Plan card — compact two-row layout: plan name + Upgrade pill
                    on one line, Credits label + value on the next. Replaces
                    the previous sentence-style blurb + separate Details
                    button, which took 4-5 lines to say the same thing. */}
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-foreground">{currentPlanName}</span>
                        {nextPlan && (
                            <Link
                                href={`/${tenantSlug}/dashboard/billing`}
                                className="flex items-center gap-1 rounded-full bg-gradient-to-br from-[#E69DB8] to-[#F2A679] px-2.5 py-1 text-[11px] font-semibold text-black shadow-sm hover:opacity-90 transition-opacity whitespace-nowrap"
                            >
                                <Zap className="h-3 w-3 fill-black shrink-0" />
                                Upgrade
                            </Link>
                        )}
                    </div>

                    {credits && (
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[12px] text-muted-foreground">Credits</span>
                            <span className="text-[12px] font-medium text-foreground">
                                {credits.unlimited
                                    ? "Unlimited"
                                    : microToCredits(credits.balanceMicro).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                        </div>
                    )}
                </div>

                <DropdownMenuSeparator className="my-2 bg-border/40" />

                {/* Navigation Section */}
                <div className="space-y-0.5">
                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => router.push(`/${tenantSlug}/dashboard/settings/profile`)}
                    >
                        <User className="mr-2.5 h-4 w-4 opacity-70" />
                        <span>Account</span>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => router.push(`/${tenantSlug}/dashboard/settings/workspace`)}
                    >
                        <Settings className="mr-2.5 h-4 w-4 opacity-70" />
                        <span>Workspace settings</span>
                    </DropdownMenuItem>

                    {isAdminOrOwner && (
                        <DropdownMenuItem
                            className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground"
                            onClick={() => router.push(`/${tenantSlug}/dashboard/developer`)}
                        >
                            <Code2 className="mr-2.5 h-4 w-4 opacity-70" />
                            <span>Developer settings</span>
                        </DropdownMenuItem>
                    )}

                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground data-[state=open]:bg-accent/50">
                            <CurrentThemeIcon className="mr-2.5 h-4 w-4 opacity-70" />
                            <span>Appearance</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent sideOffset={-8} className="w-36 rounded-2xl">
                            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                                {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                                    <DropdownMenuRadioItem key={value} value={value} className="gap-2 cursor-pointer text-[13px] rounded-xl">
                                        <Icon className="h-3.5 w-3.5" />
                                        {label}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => { window.location.href = "mailto:info@projectcontext.co" }}
                    >
                        <HelpCircle className="mr-2.5 h-4 w-4 opacity-70" />
                        <span>Help</span>
                    </DropdownMenuItem>

                    <DropdownMenuSeparator className="my-1.5 bg-border/40" />

                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl text-foreground focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => signOut()}
                    >
                        <LogOut className="mr-2.5 h-4 w-4 opacity-70" />
                        <span>Sign out</span>
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
        {!collapsed && <NotificationsBell compact />}
        </div>
        </div>
    )
}
