import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Every micro amount crosses the wire as a string — JSON.stringify throws on
// a JS BigInt, so the API serializes with String() rather than as a number.
// 1 credit = 1,000,000 micro. Divide client-side, at the render boundary only.
const MICRO_PER_CREDIT = 1_000_000;

export function microToCredits(micro: string | number | null | undefined): number {
    if (micro === null || micro === undefined) return 0;
    return Number(micro) / MICRO_PER_CREDIT;
}

export interface CreditGrant {
    grantType: string;
    amountMicro: string;
    spentMicro: string;
    expiresAt: string | null;
}

// An unlimited tenant's response has no balance figure at all — never assume
// balanceMicro/grants are present without narrowing on `unlimited` first.
export type CreditBalance =
    | { unlimited: true }
    | { unlimited: false; balanceMicro: string; grants: CreditGrant[] };

export function useCreditBalance() {
    return useQuery<CreditBalance>({
        queryKey: ['credits', 'balance'],
        queryFn: () => api.get<CreditBalance>('/api/v1/credits/balance'),
        staleTime: 30_000,
    });
}

export type CreditResourceType = 'llm_tokens' | 'message' | 'tool_call' | 'skill_run';

export interface CreditEstimateParams {
    resourceType: CreditResourceType;
    subject?: string;
    count?: number;
    inputTokens?: number;
    outputTokens?: number;
}

export interface CreditEstimate {
    costMicro: string;
    // Absent when the tenant is unlimited — the API never sends a balance
    // figure for an unlimited tenant.
    balanceMicro?: string;
    sufficient: boolean;
    rateId: string;
    rateVersion: number;
    unlimited: boolean;
}

function estimateQueryString(params: CreditEstimateParams): string {
    const search = new URLSearchParams();
    search.set('resourceType', params.resourceType);
    if (params.subject !== undefined) search.set('subject', params.subject);
    if (params.count !== undefined) search.set('count', String(params.count));
    if (params.inputTokens !== undefined) search.set('inputTokens', String(params.inputTokens));
    if (params.outputTokens !== undefined) search.set('outputTokens', String(params.outputTokens));
    return search.toString();
}

// `params` being null skips the fetch entirely (e.g. while the caller hasn't
// decided what it's about to submit yet).
export function useCreditEstimate(params: CreditEstimateParams | null) {
    return useQuery<CreditEstimate>({
        queryKey: ['credits', 'estimate', params],
        queryFn: () => api.get<CreditEstimate>(`/api/v1/credits/estimate?${estimateQueryString(params as CreditEstimateParams)}`),
        enabled: params !== null,
    });
}
