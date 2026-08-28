'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import {
    useCreditEstimate,
    microToCredits,
    type CreditEstimateParams,
    type CreditResourceType,
} from '@/lib/hooks/useCredits';

function formatCredits(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export interface ApproveCostProps {
    resourceType: CreditResourceType;
    subject?: string;
    params?: {
        count?: number;
        inputTokens?: number;
        outputTokens?: number;
    };
    onApprove: () => void;
    onCancel?: () => void;
}

export function ApproveCost({ resourceType, subject, params, onApprove, onCancel }: ApproveCostProps) {
    const { tenantSlug } = useTenant();

    const estimateParams: CreditEstimateParams = useMemo(
        () => ({
            resourceType,
            subject,
            count: params?.count,
            inputTokens: params?.inputTokens,
            outputTokens: params?.outputTokens,
        }),
        [resourceType, subject, params?.count, params?.inputTokens, params?.outputTokens],
    );

    const { data, isLoading, isError } = useCreditEstimate(estimateParams);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" data-testid="approve-cost-loading">
                <Loader2 className="h-3 w-3 animate-spin" />
                Estimating cost…
            </div>
        );
    }

    // The estimate is a preview, not a reservation — spend_credits() on the
    // real charge is the authoritative check and fails closed on its own.
    // A failed preview must never block approval: it just means this
    // control can't tell the user a number in advance.
    if (isError || !data) {
        return (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs" data-testid="approve-cost-error">
                <span className="text-muted-foreground">Couldn&apos;t estimate cost — balance will be checked when this runs.</span>
                <div className="flex gap-2">
                    {onCancel && (
                        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button type="button" size="sm" onClick={onApprove}>
                        Approve
                    </Button>
                </div>
            </div>
        );
    }

    // Unlimited tenants are never debited — no figure, no cost, no approve-gate.
    if (data.unlimited) {
        return (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs" data-testid="approve-cost-unlimited">
                <span className="text-muted-foreground">Unlimited</span>
                <div className="flex gap-2">
                    {onCancel && (
                        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button type="button" size="sm" onClick={onApprove}>
                        Approve
                    </Button>
                </div>
            </div>
        );
    }

    const insufficient = !data.sufficient;
    const costCredits = formatCredits(microToCredits(data.costMicro));
    const balanceCredits = formatCredits(microToCredits(data.balanceMicro));

    return (
        <div className="flex flex-col gap-1.5 px-3 py-2 text-xs" data-testid="approve-cost">
            <p className="text-muted-foreground">
                This costs <span className="font-medium text-foreground">{costCredits}</span> credits
                {' — Balance '}
                <span className={insufficient ? 'font-medium text-red-500' : 'font-medium text-foreground'}>
                    {balanceCredits}
                </span>
            </p>

            {insufficient && (
                <Link
                    href={`/${tenantSlug}/dashboard/billing`}
                    className="text-red-500 hover:text-red-400 font-medium transition-colors"
                >
                    Out of credits — add more →
                </Link>
            )}

            <div className="flex justify-end gap-2">
                {onCancel && (
                    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button type="button" size="sm" disabled={insufficient} onClick={onApprove}>
                    Approve
                </Button>
            </div>
        </div>
    );
}
