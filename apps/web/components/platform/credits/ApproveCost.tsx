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

// Small fractions (0.02, 0.0001) need enough precision to not just show as "0".
function formatCredits(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export interface ApproveCostProps {
    /** The question this card is asking, e.g. "Generate song" — same role as
     * ClarificationCard's question.prompt header. Required for 'card', ignored
     * for 'inline' (that surface already has its own heading/context). */
    label?: string;
    /** 'card' (default): the composer-anchored decision card, matching
     * ClarificationCard's rounded-4xl shell + numbered option + Skip[ESC]/Submit
     * footer. 'inline': the original compact one-line treatment, for surfaces
     * that embed this inside their own panel (e.g. TaskExecutionCost inside
     * PlanReviewPhase) where a second nested card shell would double up. */
    variant?: 'card' | 'inline';
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

export function ApproveCost({ label, variant = 'card', resourceType, subject, params, onApprove, onCancel }: ApproveCostProps) {
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
        return variant === 'inline' ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" data-testid="approve-cost-loading">
                <Loader2 className="h-3 w-3 animate-spin" />
                Estimating cost…
            </div>
        ) : (
            <Shell label={label} testId="approve-cost-loading">
                <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Estimating cost…
                </div>
            </Shell>
        );
    }

    // The estimate is a preview, not a reservation — spend_credits() on the
    // real charge is the authoritative check and fails closed on its own.
    // A failed preview must never block approval: it just means this
    // control can't tell the user a number in advance.
    if (isError || !data) {
        const detail = "Couldn't estimate cost — balance will be checked when this runs.";
        return variant === 'inline' ? (
            <InlineRow testId="approve-cost-error" detail={detail} onApprove={onApprove} onCancel={onCancel} />
        ) : (
            <Shell label={label} testId="approve-cost-error" onApprove={onApprove} onCancel={onCancel}>
                <Option detail={detail} onApprove={onApprove} />
            </Shell>
        );
    }

    // Unlimited tenants are never debited — no figure, no cost, no approve-gate.
    if (data.unlimited) {
        const detail = 'Unlimited';
        return variant === 'inline' ? (
            <InlineRow testId="approve-cost-unlimited" detail={detail} onApprove={onApprove} onCancel={onCancel} />
        ) : (
            <Shell label={label} testId="approve-cost-unlimited" onApprove={onApprove} onCancel={onCancel}>
                <Option detail="Unlimited plan — this won't touch your balance." onApprove={onApprove} />
            </Shell>
        );
    }

    const insufficient = !data.sufficient;
    const costCredits = formatCredits(microToCredits(data.costMicro));
    const billingLink = insufficient && (
        <Link
            href={`/${tenantSlug}/dashboard/billing`}
            className={variant === 'inline' ? 'text-destructive hover:text-destructive/80 font-medium transition-colors' : 'px-3 text-sm font-medium text-destructive transition-colors hover:text-destructive/80'}
        >
            Out of credits — add more →
        </Link>
    );

    return variant === 'inline' ? (
        <InlineRow testId="approve-cost" detail={`This costs ${costCredits} credits`} insufficient={insufficient} extra={billingLink} onApprove={onApprove} onCancel={onCancel} />
    ) : (
        <Shell label={label} testId="approve-cost" onApprove={onApprove} onCancel={onCancel} insufficient={insufficient}>
            <Option detail={`~${costCredits} credits`} insufficient={insufficient} onApprove={onApprove} />
            {billingLink}
        </Shell>
    );
}

// The original compact treatment — plain sentence + ghost/primary buttons, no
// card shell. Kept for surfaces (TaskExecutionCost) that embed this inside
// their own panel, where the new composer-card shell would nest awkwardly.
function InlineRow({
    testId,
    detail,
    insufficient,
    extra,
    onApprove,
    onCancel,
}: {
    testId: string;
    detail: string;
    insufficient?: boolean;
    extra?: ReactNode;
    onApprove: () => void;
    onCancel?: () => void;
}) {
    return (
        <div className="flex flex-col gap-1.5 px-3 py-2 text-xs" data-testid={testId}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{detail}</span>
                <div className="flex gap-2">
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
            {extra}
        </div>
    );
}

function Option({ detail, insufficient, onApprove }: { detail: string; insufficient?: boolean; onApprove: () => void }) {
    return (
        <button
            type="button"
            onClick={insufficient ? undefined : onApprove}
            disabled={insufficient}
            className="w-full text-left rounded-xl px-3 py-2.5 border border-transparent bg-accent/60 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
            <div className="text-sm font-medium">1. Approve — generate it</div>
            <div className={insufficient ? 'text-xs text-destructive mt-0.5' : 'text-xs text-muted-foreground mt-0.5'}>{detail}</div>
        </button>
    );
}

function Shell({
    label,
    testId,
    insufficient,
    onApprove,
    onCancel,
    children,
}: {
    label?: string;
    testId: string;
    insufficient?: boolean;
    onApprove?: () => void;
    onCancel?: () => void;
    children: ReactNode;
}) {
    return (
        <div className="flex w-full justify-center my-5" data-testid={testId}>
            <div className="w-full max-w-3xl flex flex-col gap-4 rounded-4xl border border-border/60 bg-card shadow-elevated p-[14px] animate-in fade-in slide-in-from-bottom-2 duration-300">
                {label && <h4 className="text-sm font-medium px-1">{label}</h4>}
                <div className="flex flex-col gap-1.5">{children}</div>
                {onApprove && (
                    <div className="border-t border-border/40 pt-4 flex items-center justify-end gap-3">
                        {onCancel && (
                            <button
                                type="button"
                                onClick={onCancel}
                                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                            >
                                <span>Cancel</span>
                                <kbd aria-hidden="true" className="text-[10px] leading-none px-1.5 py-1 rounded bg-accent text-muted-foreground/70 font-mono">ESC</kbd>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onApprove}
                            disabled={insufficient}
                            className="h-8 px-4 rounded-full text-xs font-medium bg-primary text-primary-foreground disabled:opacity-40 flex items-center gap-1.5"
                        >
                            <span>Approve</span>
                            <kbd aria-hidden="true" className="text-[10px] leading-none px-1.5 py-1 rounded bg-primary-foreground/10 text-primary-foreground/70 font-mono">↵</kbd>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
