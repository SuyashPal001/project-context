"use client"

import { Brain } from "lucide-react"
import { cn } from "@/lib/utils"

interface ProjectContextLogoProps {
    variant?: "full" | "icon"
    className?: string
    iconSize?: number
}

export function ProjectContextLogo({ variant = "full", className, iconSize = 32 }: ProjectContextLogoProps) {
    return (
        <div className={cn("flex items-center gap-2.5 select-none", className)}>
            <span
                className="shrink-0 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklch,var(--primary)_55%,transparent)]"
                style={{ width: iconSize, height: iconSize }}
            >
                <Brain
                    className="text-primary-foreground"
                    style={{ width: iconSize * 0.58, height: iconSize * 0.58 }}
                    strokeWidth={2}
                />
            </span>
            {variant === "full" && (
                <span className="text-[15px] font-bold tracking-tight text-foreground leading-none">
                    Saarthi Workflow
                </span>
            )}
        </div>
    )
}

export { ProjectContextLogo as SaarthiLogo }
