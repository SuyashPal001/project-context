"use client"

import { cn } from "@/lib/utils"

interface OlmoMarkProps {
    height?: number
    className?: string
    /** Tight, symmetric viewBox around the shape's actual bounding box
     * (x:186-814, y:42-654), instead of the default's top-padded one. The
     * default padding exists so the mark's visual weight lines up with
     * adjacent wordmark text (Sidebar, SaarthiLogo, auth screens) — that
     * same padding reads as visibly off-center when the mark stands alone
     * inside a centered avatar circle (AgentOrb, PersonaAvatar). Use this
     * there instead of changing the default and breaking wordmark layouts. */
    centered?: boolean
}

// Theme-aware mark: black in light mode, white in dark mode via currentColor.
// viewBox is padded on top (vs the tight favicon crop) so the shape's visual
// weight lines up with adjacent wordmark text instead of floating high.
export function OlmoMark({ height = 24, className, centered = false }: OlmoMarkProps) {
    return (
        <svg
            viewBox={centered ? "186 42 628 612" : "179 -8 642 670"}
            className={cn("shrink-0 text-foreground", className)}
            style={{ height, width: "auto" }}
            aria-hidden="true"
        >
            <path
                fill="currentColor"
                d="
                    M 500, 42
                    C 536, 42  554, 70  553, 118
                    C 552, 126  548, 134  542, 140
                    C 538, 144  534, 150  534, 160
                    C 534, 202  550, 248  592, 290
                    C 638, 336  700, 362  772, 376
                    C 804, 382  814, 394  810, 404
                    C 804, 416  768, 432  720, 448
                    C 620, 482  540, 560  506, 646
                    C 503, 654  497, 654  494, 646
                    C 460, 560  380, 482  280, 448
                    C 232, 432  196, 416  190, 404
                    C 186, 394  196, 382  228, 376
                    C 300, 362  362, 336  408, 290
                    C 450, 248  466, 202  466, 160
                    C 466, 150  462, 144  458, 140
                    C 452, 134  448, 126  447, 118
                    C 446, 70  464, 42  500, 42
                    Z
                "
            />
        </svg>
    )
}
