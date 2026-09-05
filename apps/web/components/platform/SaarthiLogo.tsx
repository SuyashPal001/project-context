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
                src="/brand/olmoworks-mark.svg"
                alt="OlmoWorks"
                className="shrink-0 object-contain"
                style={{ height: iconSize, width: "auto" }}
            />
            {variant === "full" && (
                <span
                    className="font-bold tracking-tight text-foreground leading-none"
                    style={{ fontSize: Math.round(iconSize * 0.82) }}
                >
                    OlmoWorks
                </span>
            )}
        </div>
    )
}

export { ProjectContextLogo as SaarthiLogo }
