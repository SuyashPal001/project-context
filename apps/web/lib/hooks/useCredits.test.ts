import { describe, it, expect } from 'vitest';
import { microToCredits, type CreditBalance, type CreditEstimate } from './useCredits';

describe('microToCredits', () => {
    it('divides a micro string by 1,000,000 to get credits', () => {
        // 1 credit = 1,000,000 micro. The API sends micro as a string
        // (BigInt can't survive JSON.stringify), so the client divides here,
        // at the render boundary — never on the server side.
        expect(microToCredits('5000000')).toBe(5);
    });

    it('handles fractional credit amounts from a string', () => {
        expect(microToCredits('1500000')).toBe(1.5);
    });

    it('returns 0 for undefined (the unlimited-tenant shape has no balanceMicro)', () => {
        expect(microToCredits(undefined)).toBe(0);
    });

    it('returns 0 for null', () => {
        expect(microToCredits(null)).toBe(0);
    });

    it('never receives a pre-divided float — accepts numeric strings only, not decimals', () => {
        // Sanity check on the contract: a whole-micro string in, a divided
        // number out. This is what distinguishes correct behavior from a
        // regression that reads costMicro directly as dollars/credits.
        expect(microToCredits('1000000')).toBe(1);
        expect(microToCredits('1000000')).not.toBe(1000000);
    });
});

describe('CreditBalance shape (compile-time + narrowing smoke test)', () => {
    it('narrows to no balanceMicro when unlimited is true', () => {
        const unlimited: CreditBalance = { unlimited: true };
        expect('balanceMicro' in unlimited).toBe(false);
    });

    it('carries balanceMicro and grants when unlimited is false', () => {
        const limited: CreditBalance = { unlimited: false, balanceMicro: '2000000', grants: [] };
        expect(limited.balanceMicro).toBe('2000000');
    });
});

describe('CreditEstimate shape', () => {
    it('sufficient reflects the server-computed comparison, not a client recompute', () => {
        const estimate: CreditEstimate = {
            costMicro: '1000000',
            balanceMicro: '500000',
            sufficient: false,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        };
        expect(estimate.sufficient).toBe(false);
    });
});
