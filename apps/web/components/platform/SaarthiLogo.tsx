"use client"

import { cn } from "@/lib/utils"

// Saarthi AI — logomark SVG
// The mark is a stylised compass/waypoint: a circle with a dynamic arrow
// pointing northeast, suggesting guidance + intelligence.
function SaarthiMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
    return (
        <svg
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            style={style}
            aria-hidden="true"
        >
            {/* Outer glow ring */}
            <circle cx="16" cy="16" r="15" stroke="url(#ring)" strokeWidth="1.5" opacity="0.4" />
            {/* Background circle fill */}
            <circle cx="16" cy="16" r="13" fill="url(#bg)" />
            {/* Compass arrow — points NE, slightly rotated for dynamism */}
            <path
                d="M10 22 L15.5 9 L21 22 L15.5 18.5 Z"
                fill="url(#arrow)"
                strokeLinejoin="round"
            />
            {/* Dark rear half of compass */}
            <path
                d="M10 22 L15.5 18.5 L15.5 9 Z"
                fill="white"
                opacity="0.15"
            />
            <defs>
                <linearGradient id="bg" x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="100%" stopColor="#4f46e5" />
                </linearGradient>
                <linearGradient id="arrow" x1="10" y1="9" x2="21" y2="22" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                    <stop offset="100%" stopColor="#c7d2fe" stopOpacity="0.85" />
                </linearGradient>
                <linearGradient id="ring" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#818cf8" />
                    <stop offset="100%" stopColor="#4f46e5" />
                </linearGradient>
            </defs>
        </svg>
    )
}

interface SaarthiLogoProps {
    /** Show icon + wordmark */
    variant?: "full" | "icon"
    className?: string
    /** Size of the icon in px */
    iconSize?: number
}

export function SaarthiLogo({ variant = "full", className, iconSize = 32 }: SaarthiLogoProps) {
    return (
        <div className={cn("flex items-center gap-2.5 select-none", className)}>
            <SaarthiMark
                className="shrink-0 drop-shadow-[0_0_8px_rgba(99,102,241,0.45)]"
                style={{ width: iconSize, height: iconSize }}
            />
            {variant === "full" && (
                <div className="flex flex-col leading-none">
                    <span className="text-[15px] font-bold tracking-tight text-foreground">
                        Saarthi
                        <span className="ml-[3px] text-[11px] font-semibold tracking-widest text-indigo-400 uppercase align-super">
                            AI
                        </span>
                    </span>
                </div>
            )}
        </div>
    )
}
