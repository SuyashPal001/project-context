/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDetachedReplyWatch } from './useDetachedReplyWatch';

const msg = (id: string, role: 'user' | 'assistant') => ({ id, role, content: '', conversationId: 'c1', createdAt: '' }) as never;

afterEach(() => vi.useRealTimers());

describe('useDetachedReplyWatch', () => {
    it("re-reads the chat until Olmo's reply lands, then stops", () => {
        vi.useFakeTimers();
        const queryClient = { invalidateQueries: vi.fn() } as never as import('@tanstack/react-query').QueryClient;
        const before = [msg('u1', 'user'), msg('a1', 'assistant')];
        const { result, rerender } = renderHook(({ messages }) => useDetachedReplyWatch('c1', messages, queryClient), { initialProps: { messages: before } });

        act(() => result.current.watch());
        expect(result.current.watching).toBe(true);
        act(() => { vi.advanceTimersByTime(3000); });
        expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['messages', 'c1'] });

        // The user's own answer is not the reply.
        rerender({ messages: [...before, msg('u2', 'user')] });
        expect(result.current.watching).toBe(true);
        rerender({ messages: [...before, msg('u2', 'user'), msg('a2', 'assistant')] });
        expect(result.current.watching).toBe(false);
    });

    it('gives up after ten minutes', () => {
        vi.useFakeTimers();
        const queryClient = { invalidateQueries: vi.fn() } as never as import('@tanstack/react-query').QueryClient;
        const { result } = renderHook(() => useDetachedReplyWatch('c1', [], queryClient));
        act(() => result.current.watch());
        act(() => { vi.advanceTimersByTime(10 * 60 * 1000 + 3000); });
        expect(result.current.watching).toBe(false);
    });
});
