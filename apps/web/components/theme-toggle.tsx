"use client"

import * as React from "react"
import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const OPTIONS = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
] as const

export function ThemeToggle({
    collapsed = false,
    variant = "sidebar",
}: {
    collapsed?: boolean
    variant?: "sidebar" | "icon"
}) {
    const { theme, setTheme } = useTheme()
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => setMounted(true), [])

    const current = OPTIONS.find(o => o.value === theme) ?? OPTIONS[2]
    const Icon = mounted ? current.icon : Monitor

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {variant === "icon" ? (
                    <button
                        className="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all text-muted-foreground hover:text-foreground hover:bg-accent/50"
                        aria-label="Change theme"
                    >
                        <Icon className="w-[18px] h-[18px]" />
                    </button>
                ) : (
                    <button
                        className={cn(
                            "flex items-center rounded-md py-2 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors",
                            collapsed ? "justify-center px-2 w-full" : "gap-2.5 px-3 w-full"
                        )}
                        aria-label="Change theme"
                    >
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        {!collapsed && <span className="text-[12px]">{current.label}</span>}
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side={variant === "icon" ? "bottom" : collapsed ? "right" : "top"} className="w-36">
                {OPTIONS.map(({ value, label, icon: OptIcon }) => (
                    <DropdownMenuItem
                        key={value}
                        onClick={() => setTheme(value)}
                        className={cn("gap-2 cursor-pointer", theme === value && "text-foreground font-medium")}
                    >
                        <OptIcon className="h-3.5 w-3.5" />
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
