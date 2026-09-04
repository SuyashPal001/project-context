'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditBalance, microToCredits } from '@/lib/hooks/useCredits';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CreditsPanel } from './CreditsPanel';

// Sits beside UsageBar in the sidebar — now a click target that opens
// CreditsPanel (breakdown by type + percent-consumed + top-up), not just a
// passive readout. ApproveCost (the estimate-and-approve gate shown inline
// on submit) is unrelated and untouched.
export function CreditBalanceIndicator() {
    const { tenantSlug } = useTenant();
    const { data } = useCreditBalance();

    if (!data) return null;

    // Unlimited tenants are never debited — no figure, no panel, ever.
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
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="w-full text-left px-3 py-2 mb-2 space-y-1 rounded-md hover:bg-muted/50 transition-colors"
                    data-testid="credit-balance"
                >
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
                            onClick={(e) => e.stopPropagation()}
                        >
                            Add credits →
                        </Link>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" className="p-0">
                <CreditsPanel />
            </PopoverContent>
        </Popover>
    );
}
