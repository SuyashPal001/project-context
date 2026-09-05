"use client"

import { cn } from "@/lib/utils"
import { OlmoMark } from "@/components/platform/OlmoMark"

interface ProjectContextLogoProps {
    variant?: "full" | "icon"
    className?: string
    iconSize?: number
}

export function ProjectContextLogo({ variant = "full", className, iconSize = 32 }: ProjectContextLogoProps) {
    return (
        <div className={cn("flex items-center gap-2.5 select-none", className)}>
            <OlmoMark height={iconSize} />
            {variant === "full" && (
                <span
                    className="font-bold tracking-tight text-foreground leading-none"
                    style={{ fontSize: Math.round(iconSize * 0.5) }}
                >
                    OlmoWorks
                </span>
            )}
        </div>
    )
}

export { ProjectContextLogo as SaarthiLogo }
