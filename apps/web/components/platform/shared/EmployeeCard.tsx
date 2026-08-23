"use client";

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { Brain } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface EmployeeOutcome {
    url: string;
    caption: string | null;
}

export interface EmployeeCardProps {
    /** Wrap the card in a Link (Mine — goes to the agent detail page). Mutually exclusive with onClick. */
    href?: string;
    /** Make the whole card a click target (Explore — opens the persona detail modal). */
    onClick?: () => void;
    avatar: ReactNode;
    name: string;
    /** A single small badge next to the name — Official (persona) or role type (agent). */
    headerBadge?: ReactNode;
    subtitle: ReactNode;
    /** Top-right affordance — Hire pill, or a status pill + management menu. */
    action: ReactNode;
    skillTags?: string[];
    outcomes?: EmployeeOutcome[];
    mind?: string | null;
    dimmed?: boolean;
    className?: string;
}

/**
 * Shared layout shell for the Mine (AgentCard) and Explore (PersonaCard) cards.
 * Both wrappers hand in their own data + action, but neither owns any spacing or
 * typography class — that lives here, once, so the two views can't silently drift
 * apart the way they did before this component existed.
 */
export function EmployeeCard({
    href,
    onClick,
    avatar,
    name,
    headerBadge,
    subtitle,
    action,
    skillTags = [],
    outcomes = [],
    mind,
    dimmed,
    className,
}: EmployeeCardProps) {
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
    };

    const body = (
        <Card
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            onClick={onClick}
            onKeyDown={onClick ? handleKeyDown : undefined}
            className={cn(
                "gap-4 overflow-hidden p-5 transition-colors hover:border-foreground/20",
                onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                dimmed && "opacity-75",
                className,
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    {avatar}
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="text-base font-bold text-foreground">{name}</h3>
                            {headerBadge}
                        </div>
                        <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>
                    </div>
                </div>
                <div className="shrink-0" onClick={(e: MouseEvent) => onClick && e.stopPropagation()}>
                    {action}
                </div>
            </div>

            {(skillTags.length > 0 || outcomes.length > 0) && <hr className="border-border" />}

            {skillTags.length > 0 && (
                <div>
                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Skills</span>
                    <div className="flex flex-wrap gap-1.5">
                        {skillTags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>
                        ))}
                    </div>
                </div>
            )}

            {outcomes.length > 0 && (
                <div>
                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Outcomes</span>
                    <div className={outcomes.length > 1 ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
                        {outcomes.map((outcome, i) => (
                            <figure key={i} className="relative overflow-hidden rounded-lg border border-border">
                                {/* eslint-disable-next-line @next/next/no-img-element -- persona-authored example asset, not a static build asset */}
                                <img src={outcome.url} alt={outcome.caption ?? name} className="aspect-video w-full object-cover" />
                                {outcome.caption && (
                                    <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-white">
                                        {outcome.caption}
                                    </figcaption>
                                )}
                            </figure>
                        ))}
                    </div>
                </div>
            )}

            {mind && (
                <div className="flex items-center justify-between border-t border-border pt-4 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <Brain className="h-3.5 w-3.5" /> Mind
                    </span>
                    <span className="font-medium text-foreground">{mind}</span>
                </div>
            )}
        </Card>
    );

    if (href) {
        return (
            <Link href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {body}
            </Link>
        );
    }
    return body;
}
