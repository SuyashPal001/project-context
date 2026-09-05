"use client"

import { cn } from "@/lib/utils"

interface ProjectContextLogoProps {
    variant?: "full" | "icon"
    className?: string
    iconSize?: number
}

export function ProjectContextLogo({ variant = "full", className, iconSize = 32 }: ProjectContextLogoProps) {
    return (
        <div className={cn("flex items-center gap-2.5 select-none", className)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src="/brand/olmoworks-mark-sm.png"
                alt="OlmoWorks"
                className="shrink-0 object-contain"
                style={{ width: iconSize, height: iconSize }}
            />
            {variant === "full" && (
                <span className="text-[15px] font-bold tracking-tight text-foreground leading-none">
                    OlmoWorks
                </span>
            )}
        </div>
    )
}

export { ProjectContextLogo as SaarthiLogo }
