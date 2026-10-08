/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('./useChat/auth', () => ({
    getAuthTokens: () => ({ accessToken: 'a', idToken: 'i' }),
    getFreshAuthTokens: async () => ({ accessToken: 'a', idToken: 'i' }),
    attemptRefresh: async () => true,
}));

import { useChat } from './useChat';

afterEach(() => vi.unstubAllGlobals());

describe('sendGenerationConfirm', () => {
    it("says 'gone' when no open page holds the card, so the click can resume its stored run", async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
        const { result } = renderHook(() => useChat({ agentId: 'a1' } as never));
        expect(await result.current.sendGenerationConfirm('tc-1', 'approved')).toBe('gone');
    });

    it('is true for a live card and false for other failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValueOnce({ ok: false, status: 500 }));
        const { result } = renderHook(() => useChat({ agentId: 'a1' } as never));
        expect(await result.current.sendGenerationConfirm('tc-1', 'approved')).toBe(true);
        expect(await result.current.sendGenerationConfirm('tc-1', 'declined')).toBe(false);
    });
});
