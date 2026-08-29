'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditBalance, microToCredits } from '@/lib/hooks/useCredits';
import { cn } from '@/lib/utils';

// Sits beside UsageBar in the sidebar — a passive balance readout, not the
// estimate-and-approve gate (that's ApproveCost, shown inline on submit).
export function CreditBalanceIndicator() {
    const { tenantSlug } = useTenant();
    const { data } = useCreditBalance();

    if (!data) return null;

    // Unlimited tenants are never debited — no figure, ever.
    if (data.unlimited) {
        return (
            <div className="px-3 py-2 mb-2" data-testid="credit-balance-unlimited">
                <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">Unlimited</span> credits
                </p>
            </div>
        );
    }

    const balanceCredits = microToCredits(data.balanceMicro);
    const isLow = balanceCredits <= 0;

    return (
        <div className="px-3 py-2 mb-2 space-y-1" data-testid="credit-balance">
            <p className="text-[11px] text-muted-foreground">
                <span className={cn('font-medium', isLow ? 'text-red-500' : 'text-foreground')}>
                    {balanceCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                {' credits'}
            </p>

            {isLow && (
                <Link
                    href={`/${tenantSlug}/dashboard/billing`}
                    className="text-[11px] text-red-500 hover:text-red-400 font-medium transition-colors"
                >
                    Add credits →
                </Link>
            )}
        </div>
    );
}
