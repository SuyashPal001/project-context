"use client"

import { useId } from "react"
import { cn } from "@/lib/utils"

interface OlmoMarkProps {
    height?: number
    className?: string
    /** Tight viewBox around the circle, for when the mark stands alone inside
     * a centered avatar circle (AgentOrb, PersonaAvatar). The default keeps
     * a hairline of padding so it sits evenly beside wordmark text. */
    centered?: boolean
}

// Theme-aware platform mark (ads-platform-mark.svg): a disc with a play-card
// and hook cut out of it. Filled with currentColor so it is black in light
// mode and white in dark mode; the cut-outs show whatever is behind it.
export function OlmoMark({ height = 24, className, centered = false }: OlmoMarkProps) {
    // Each instance needs its own mask id — several marks render on one page.
    const maskId = `platform-mark-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

    return (
        <svg
            viewBox={centered ? "1 1 62 62" : "0 0 64 64"}
            className={cn("shrink-0 text-foreground", className)}
            style={{ height, width: "auto" }}
            aria-hidden="true"
        >
            <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
                    <rect width="64" height="64" fill="#fff" />
                    <path
                        d="M45 8V37a12.5 12.5 0 0 1-25 0v-9"
                        fill="none"
                        stroke="#000"
                        strokeWidth="3.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <rect x="24.5" y="24.5" width="18" height="22" rx="5" fill="#fff" transform="rotate(-8 33 36)" />
                    <rect x="27" y="27" width="13" height="17" rx="3" fill="#000" transform="rotate(-8 33 36)" />
                    <path
                        d="M31 32.5v7l5.5-3.5Z"
                        fill="#fff"
                        stroke="#fff"
                        strokeWidth="1"
                        strokeLinejoin="round"
                        transform="rotate(-8 33 36)"
                    />
                </mask>
            </defs>
            <circle cx="32" cy="32" r="31" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
    )
}
