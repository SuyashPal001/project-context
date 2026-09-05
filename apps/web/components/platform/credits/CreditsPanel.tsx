'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditUsageByType, microToCredits } from '@/lib/hooks/useCredits';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

function Row({ label, credits }: { label: string; credits: number }) {
    return (
        <div className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
    );
}

// Mirrors the loaded layout's exact structure (title, percent line, 4 rows,
// total row, button) rather than a generic spinner or unrelated placeholder
// shape — so nothing shifts or resizes once the real data lands.
function CreditsPanelSkeleton({ className }: { className?: string }) {
    return (
        <div data-testid="credits-panel-loading" className={cn('w-64 p-3', className)}>
            <Skeleton className="h-3 w-20 mb-2.5" />
            <Skeleton className="h-6 w-28 mb-2.5" />

            <div className="border-t border-border/60">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5">
                        <Skeleton className="h-3.5 w-20" />
                        <Skeleton className="h-3.5 w-10" />
                    </div>
                ))}
            </div>

            <div className="border-t border-border/60 pt-1.5 mt-1.5 flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-10" />
            </div>

            <Skeleton className="mt-3 h-8 w-full rounded-md" />
        </div>
    );
}

// className overrides the default standalone-popover sizing (w-64 p-3) for
// callers that embed this inline instead — e.g. AccountMenu's Credits row,
// which reveals it inside a narrower card rather than a floating popover.
export function CreditsPanel({ className }: { className?: string } = {}) {
    const { tenantSlug } = useTenant();
    const { data, isLoading } = useCreditUsageByType();

    if (isLoading || !data) {
        return <CreditsPanelSkeleton className={className} />;
    }

    if (data.unlimited) {
        return <div data-testid="credits-panel-unlimited" className={cn('p-3 text-sm', className)}>Unlimited credits</div>;
    }

    const byType = data.byType ?? { text: '0', image: '0', video: '0', audio: '0' };
    const percentConsumed = data.lastGrant && data.lastGrant.amountMicro !== '0'
        ? Math.round((Number(data.lastGrant.spentMicro) / Number(data.lastGrant.amountMicro)) * 100)
        : null;

    return (
        <div data-testid="credits-panel" className={cn('w-64 p-3', className)}>
            <p className="text-xs font-semibold text-muted-foreground mb-2">Your Credits</p>

            {percentConsumed !== null && (
                <p data-testid="credits-panel-percent" className="text-lg font-semibold mb-2">{percentConsumed}% consumed</p>
            )}

            <div className="border-t border-border/60">
                <Row label="Text credits" credits={microToCredits(byType.text)} />
                <Row label="Image credits" credits={microToCredits(byType.image)} />
                <Row label="Video credits" credits={microToCredits(byType.video)} />
                <Row label="Audio credits" credits={microToCredits(byType.audio)} />
            </div>

            <div className="border-t border-border/60 pt-1.5 mt-1.5 flex items-center justify-between text-sm font-medium">
                <span>Total credits</span>
                <span className="font-mono">{microToCredits(data.totalMicro).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>

            <Link
                href={`/${tenantSlug}/dashboard/billing`}
                data-testid="credits-panel-topup"
                className="mt-3 block text-center text-sm font-medium rounded-md py-1.5 bg-foreground text-background hover:opacity-90 transition-opacity"
            >
                Top-up credits
            </Link>
        </div>
    );
}
