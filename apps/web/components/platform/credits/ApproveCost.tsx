'use client';

import { useMemo, type ReactNode } from 'react';
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

// Cost is often a small fraction (0.02, 0.0001) — needs enough precision to
// not just show as "0". Balance is a running total in the thousands, where
// 6 decimal places is noise, not precision — 2 is plenty.
function formatCredits(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatBalance(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground" data-testid="approve-cost-loading">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
            <ApproveCostShell
                testId="approve-cost-error"
                optionLabel="Approve — generate it"
                optionDetail="Couldn't estimate cost — balance will be checked when this runs."
                onApprove={onApprove}
                onCancel={onCancel}
            />
        );
    }

    // Unlimited tenants are never debited — no figure, no cost, no approve-gate.
    if (data.unlimited) {
        return (
            <ApproveCostShell
                testId="approve-cost-unlimited"
                optionLabel="Approve — generate it"
                optionDetail="Unlimited plan — this won't touch your balance."
                onApprove={onApprove}
                onCancel={onCancel}
            />
        );
    }

    const insufficient = !data.sufficient;
    const costCredits = formatCredits(microToCredits(data.costMicro));
    const balanceCredits = formatBalance(microToCredits(data.balanceMicro));

    return (
        <ApproveCostShell
            optionLabel="Approve — generate it"
            optionDetail={`~${costCredits} credits · Balance ${balanceCredits}`}
            insufficient={insufficient}
            footer={insufficient && (
                <Link
                    href={`/${tenantSlug}/dashboard/billing`}
                    className="text-sm font-medium text-destructive transition-colors hover:text-destructive/80"
                >
                    Out of credits — add more →
                </Link>
            )}
            onApprove={onApprove}
            onCancel={onCancel}
        />
    );
}

// Shared visual shell for all four estimate states (loading handled separately
// above) — one numbered "option" row for Approve, plus a footer with Cancel /
// Approve and their keyboard hints. Only one real choice exists today (visual
// polish only, no new decision branches) but the option-row treatment reads
// far clearer than a plain sentence + two buttons.
function ApproveCostShell({
    testId = 'approve-cost',
    optionLabel,
    optionDetail,
    insufficient,
    footer,
    onApprove,
    onCancel,
}: {
    testId?: string;
    optionLabel: string;
    optionDetail: string;
    insufficient?: boolean;
    footer?: ReactNode;
    onApprove: () => void;
    onCancel?: () => void;
}) {
    return (
        <div className="flex flex-col gap-3 px-4 py-4" data-testid={testId}>
            <button
                type="button"
                onClick={insufficient ? undefined : onApprove}
                disabled={insufficient}
                className="w-full rounded-lg bg-muted/60 px-3.5 py-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
                <div className="text-sm font-semibold text-foreground">{optionLabel}</div>
                <div className={insufficient ? 'mt-0.5 text-sm text-destructive' : 'mt-0.5 text-sm text-muted-foreground'}>
                    {optionDetail}
                </div>
            </button>

            {footer}

            <div className="flex items-center justify-between border-t border-border pt-3">
                {onCancel ? (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Cancel
                        <kbd aria-hidden="true" className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">ESC</kbd>
                    </button>
                ) : <span />}
                <Button type="button" size="sm" disabled={insufficient} onClick={onApprove} className="gap-1.5">
                    Approve
                    <kbd aria-hidden="true" className="rounded border border-primary-foreground/25 bg-primary-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">↵</kbd>
                </Button>
            </div>
        </div>
    );
}
