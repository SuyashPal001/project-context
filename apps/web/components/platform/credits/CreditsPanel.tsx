'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditUsageByType, microToCredits } from '@/lib/hooks/useCredits';

function Row({ label, credits }: { label: string; credits: number }) {
    return (
        <div className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
    );
}

export function CreditsPanel() {
    const { tenantSlug } = useTenant();
    const { data, isLoading } = useCreditUsageByType();

    if (isLoading || !data) {
        return <div data-testid="credits-panel-loading" className="p-3 text-sm text-muted-foreground">Loading…</div>;
    }

    if (data.unlimited) {
        return <div data-testid="credits-panel-unlimited" className="p-3 text-sm">Unlimited credits</div>;
    }

    const byType = data.byType ?? { text: '0', image: '0', video: '0', audio: '0' };
    const percentConsumed = data.lastGrant && data.lastGrant.amountMicro !== '0'
        ? Math.round((Number(data.lastGrant.spentMicro) / Number(data.lastGrant.amountMicro)) * 100)
        : null;

    return (
        <div data-testid="credits-panel" className="w-64 p-3">
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
