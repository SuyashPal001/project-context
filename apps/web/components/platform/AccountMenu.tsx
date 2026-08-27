"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { User, LogOut, ChevronsUpDown, Sun, Moon, Monitor, Zap } from "lucide-react"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { signOut } from "@/lib/auth"
import { cn } from "@/lib/utils"
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

    const isStarterPlan = ['free', 'starter'].includes(plan?.toLowerCase() || '')
    const currentThemeIcon = mounted ? (THEME_OPTIONS.find(o => o.value === theme)?.icon ?? Monitor) : Monitor
    const CurrentThemeIcon = currentThemeIcon

    return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger className="focus:outline-none w-full">
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
                                <p className="text-[13px] font-medium text-foreground truncate leading-none mb-1">
                                    {name || "User"}
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
                    "p-2.5 rounded-[28px] bg-card border-border/50 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28),0_8px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.65),0_10px_28px_-8px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgba(255,255,255,0.05)]",
                    // Expanded: sit flush inside the sidebar column, same as the reference,
                    // by matching the trigger's own width rather than a fixed px value.
                    // Collapsed: the trigger is a small icon button, so that width would be
                    // far too narrow — keep a fixed size and float it off to the side instead.
                    collapsed ? "w-[272px]" : "w-(--radix-dropdown-menu-trigger-width)",
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

                {/* Plan card */}
                <div className="rounded-3xl border border-border/60 bg-muted/30 p-3.5 space-y-2">
                    <p className="text-[11px] text-muted-foreground truncate leading-none">
                        {tenantSlug}
                    </p>
                    <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-foreground capitalize">{plan || "Free"}</span>
                        {isStarterPlan && (
                            <Link
                                href={`/${tenantSlug}/dashboard/billing`}
                                className="flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
                            >
                                <Zap className="h-3 w-3 text-primary" />
                                Upgrade
                            </Link>
                        )}
                    </div>
                </div>

                <DropdownMenuSeparator className="my-2 bg-border/40" />

                {/* Navigation Section */}
                <div className="space-y-0.5">
                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => router.push(`/${tenantSlug}/dashboard/settings/profile`)}
                    >
                        <User className="mr-2.5 h-4 w-4 opacity-70" />
                        <span>Profile settings</span>
                    </DropdownMenuItem>

                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-2xl focus:bg-accent/50 focus:text-accent-foreground data-[state=open]:bg-accent/50">
                            <CurrentThemeIcon className="mr-2.5 h-4 w-4 opacity-70" />
                            <span>Theme</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-36 rounded-2xl">
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

                    <DropdownMenuSeparator className="my-1.5 bg-border/40" />

                    <DropdownMenuItem
                        className="flex items-center px-2 py-2.5 cursor-pointer text-[13px] rounded-xl text-muted-foreground hover:text-foreground focus:bg-accent/50 focus:text-accent-foreground group"
                        onClick={() => signOut()}
                    >
                        <LogOut className="mr-2.5 h-4 w-4 opacity-70 group-hover:opacity-100 transition-opacity" />
                        <span>Sign out</span>
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
