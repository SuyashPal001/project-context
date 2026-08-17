"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { User, LogOut, ChevronsUpDown, Sun, Moon, Monitor } from "lucide-react"
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
        return "bg-zinc-500" // Admin/Owner default
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
            <DropdownMenuContent align="start" side={collapsed ? "right" : "top"} className="w-[240px] p-0 overflow-hidden bg-card border-border shadow-md">
                {/* Header Block - Non-clickable */}
                <div className="flex flex-col space-y-0.5 p-3 px-[12px] bg-accent/5">
                    <p className="text-[13px] font-medium text-foreground truncate">{name || "User"}</p>
                    <p className="text-[12px] text-muted-foreground truncate overflow-hidden whitespace-nowrap">
                        {email || "user@platform.com"}
                    </p>
                </div>

                <DropdownMenuSeparator className="m-0 bg-border/40" />

                {/* Metadata Section */}
                <div className="p-[8px] px-[12px] space-y-1">
                    <p className="text-[12px] text-muted-foreground truncate leading-tight">
                        {tenantSlug}
                    </p>
                    <div className="flex items-center gap-1.5 text-[12px] leading-tight">
                        <span className="text-foreground capitalize">{plan || "Free"}</span>
                        {isStarterPlan && (
                            <>
                                <span className="text-muted-foreground/30 font-light translate-y-[-1px]">·</span>
                                <Link
                                    href={`/${tenantSlug}/dashboard/billing`}
                                    className="text-primary/80 hover:text-primary font-medium transition-colors"
                                >
                                    Upgrade
                                </Link>
                            </>
                        )}
                    </div>
                </div>

                <DropdownMenuSeparator className="m-0 bg-border/40" />

                {/* Navigation Section */}
                <div className="p-[4px] px-[4px]">
                    <DropdownMenuItem
                        className="flex items-center px-[12px] py-[8px] cursor-pointer text-[13px] rounded-sm focus:bg-accent/50 focus:text-accent-foreground"
                        onClick={() => router.push(`/${tenantSlug}/dashboard/settings/profile`)}
                    >
                        <User className="mr-2 h-4 w-4 opacity-70" />
                        <span>Profile settings</span>
                    </DropdownMenuItem>

                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="flex items-center px-[12px] py-[8px] cursor-pointer text-[13px] rounded-sm focus:bg-accent/50 focus:text-accent-foreground data-[state=open]:bg-accent/50">
                            <CurrentThemeIcon className="mr-2 h-4 w-4 opacity-70" />
                            <span>Theme</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-36">
                            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                                {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                                    <DropdownMenuRadioItem key={value} value={value} className="gap-2 cursor-pointer text-[13px]">
                                        <Icon className="h-3.5 w-3.5" />
                                        {label}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuSeparator className="my-[4px] bg-border/40 mx-[-4px]" />

                    <DropdownMenuItem
                        className="flex items-center px-[12px] py-[8px] cursor-pointer text-[13px] rounded-sm text-muted-foreground hover:text-foreground focus:bg-accent/50 focus:text-accent-foreground group"
                        onClick={() => signOut()}
                    >
                        <LogOut className="mr-2 h-4 w-4 opacity-70 group-hover:opacity-100 transition-opacity" />
                        <span>Sign out</span>
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
