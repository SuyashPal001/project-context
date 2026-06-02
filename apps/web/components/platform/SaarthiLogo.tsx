"use client"

import { cn } from "@/lib/utils"

interface ProjectContextLogoProps {
    variant?: "full" | "icon"
    className?: string
    iconSize?: number
}

export function ProjectContextLogo({ variant = "full", className, iconSize = 32 }: ProjectContextLogoProps) {
    const dotSize = Math.round(iconSize * 0.28)
    return (
        <div className={cn("flex items-center gap-2.5 select-none", className)}>
            <span
                className="shrink-0 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.55)]"
                style={{ width: dotSize, height: dotSize }}
            />
            {variant === "full" && (
                <span className="text-[15px] font-bold tracking-tight text-foreground leading-none">
                    Project Context
                </span>
            )}
        </div>
    )
}

export { ProjectContextLogo as SaarthiLogo }
