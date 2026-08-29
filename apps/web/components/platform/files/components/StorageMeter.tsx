"use client";

const GB = 1024 ** 3;
const VISIBLE_AT_PERCENT = 80;

/**
 * Storage limits are an unadvertised abuse ceiling, so the meter stays hidden
 * during ordinary use and appears only once a tenant is close enough that being
 * blocked is a real prospect.
 */
export function shouldShowMeter(usage: { percent: number; unlimited: boolean }): boolean {
    if (usage.unlimited) return false;
    return usage.percent >= VISIBLE_AT_PERCENT;
}

/**
 * Whole GB once past 1GB, two decimals below it. A tenant at 80% of a small
 * limit would otherwise read "0 GB of 1 GB", which looks like a bug rather than
 * the warning it is.
 */
function formatGb(bytes: number): string {
    const gb = bytes / GB;
    return `${gb >= 1 ? Math.round(gb) : Number(gb.toFixed(2))} GB`;
}

export function StorageMeter({ percent, usedBytes, limitBytes }: {
    percent: number;
    usedBytes: number;
    limitBytes: number;
}) {
    return (
        <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-secondary border border-border text-sm">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                {/* bg-shimmer-accent, not bg-primary: the pale rose --primary fails
                    WCAG AA on the light theme, which FilesList already documents at
                    its "ready to work with" banner. */}
                <div className="h-full bg-shimmer-accent" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-muted-foreground whitespace-nowrap">
                {formatGb(usedBytes)} of {formatGb(limitBytes)} used
            </span>
        </div>
    );
}
