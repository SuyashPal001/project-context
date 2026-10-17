import { describe, it, expect } from 'vitest';
import { ApiError } from '@/lib/api';
import { importErrorMessage } from './brandApi';

const FALLBACK = "Couldn't read that.";

describe('importErrorMessage', () => {
    it('shows the format hint the API sends with a 400', () => {
        expect(importErrorMessage(new ApiError(400, { message: 'Paste a website link or an Instagram handle' }), FALLBACK))
            .toBe('Paste a website link or an Instagram handle');
    });

    it('falls back to the format hint for a 400 with no message', () => {
        expect(importErrorMessage(new ApiError(400, { success: false }), FALLBACK)).toBe('Paste a website link or an Instagram handle');
    });

    it('uses the fallback for anything else', () => {
        expect(importErrorMessage(new ApiError(500, { message: 'boom' }), FALLBACK)).toBe(FALLBACK);
        expect(importErrorMessage(new Error('network'), FALLBACK)).toBe(FALLBACK);
    });
});
