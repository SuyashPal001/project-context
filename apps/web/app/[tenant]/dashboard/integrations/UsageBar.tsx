"use client";

import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface UsageBarProps {
    used: number;
    limit: number;
    unlimited: boolean;
    atLimit: boolean;
    pct: number;
    billingHref?: string;
}

export function UsageBar({ used, limit, unlimited, atLimit, pct, billingHref }: UsageBarProps) {
    return (
        <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                    <span className={cn("font-medium", atLimit ? "text-red-500" : "text-foreground")}>
                        {used}
                    </span>
                    {unlimited ? " connectors connected" : ` of ${limit} connectors connected`}
                </span>
                {atLimit && billingHref && (
                    <Link
                        href={billingHref}
                        className="text-xs font-medium text-red-500 hover:text-red-400 transition-colors"
                    >
                        Upgrade for more →
                    </Link>
                )}
            </div>
            {!unlimited && (
                <Progress
                    value={pct}
                    className={cn(
                        "h-1.5",
                        atLimit         ? "[&>div]:bg-red-500" :
                        pct >= 80       ? "[&>div]:bg-amber-500" :
                                          "[&>div]:bg-muted-foreground/40"
                    )}
                />
            )}
        </div>
    );
}
