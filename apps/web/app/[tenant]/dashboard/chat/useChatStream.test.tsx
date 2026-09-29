/** @vitest-environment jsdom */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { api } from '@/lib/api';
import { mapStreamAttachments } from './useChatStream';
import { useChatStream } from './useChatStream';

const chatMock = vi.hoisted(() => ({
    sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
    cancel: vi.fn(),
    lastOptions: undefined as undefined | {
        onGenerationConfirmRequired?: (...args: unknown[]) => void;
        onToolCall?: (...args: unknown[]) => void;
        onBatchItemProgress?: (...args: unknown[]) => void;
        onReasoning?: (...args: unknown[]) => void;
        onToolDone?: (...args: unknown[]) => void;
        onDone?: (...args: unknown[]) => void;
    },
}));

vi.mock('@/hooks/useChat', () => ({
    useChat: (options: {
        onGenerationConfirmRequired?: (...args: unknown[]) => void;
        onToolCall?: (...args: unknown[]) => void;
        onBatchItemProgress?: (...args: unknown[]) => void;
        onReasoning?: (...args: unknown[]) => void;
        onToolDone?: (...args: unknown[]) => void;
        onDone?: (...args: unknown[]) => void;
    }) => {
        chatMock.lastOptions = options;
        return {
            sendMessage: chatMock.sendMessage,
            sendApproval: vi.fn(),
            sendGenerationConfirm: vi.fn(),
            sendClarificationAnswer: vi.fn(),
            sendUploadAnswer: vi.fn(),
            cancel: chatMock.cancel,
            isStreaming: false,
            isRetrying: false,
        };
    },
}));

afterEach(() => {
    vi.restoreAllMocks();
    chatMock.sendMessage.mockReset();
    chatMock.cancel.mockReset();
});

describe('mapStreamAttachments', () => {
    it('carries generation through when the orchestrator includes it', () => {
        // Regression: a prior fix (b43e03d9) dropped `generation` from this
        // exact map, so a just-generated image's credit pill never appeared
        // even in the same turn — only caught by a whole-branch review, not
        // any per-task test. This is the test that closes that gap.
        const [result] = mapStreamAttachments([
            { fileId: 'f1', name: 'x.png', type: 'image/png', size: 100, generation: { creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' } },
        ]);

        expect(result.generation).toEqual({ creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' });
    });

    it('omits generation for a plain user-uploaded attachment', () => {
        const [result] = mapStreamAttachments([
            { fileId: 'f2', name: 'doc.pdf', type: 'application/pdf', size: 200 },
        ]);

        expect(result.generation).toBeUndefined();
    });

    it('synthesizes a local UI id and preserves the rest of the fields', () => {
        const [result] = mapStreamAttachments([
            { fileId: 'f3', name: 'clip.mp4', type: 'video/mp4', size: 300 },
        ]);

        expect(result.id).toEqual(expect.any(String));
        expect(result.id.length).toBeGreaterThan(0);
        expect(result.fileId).toBe('f3');
        expect(result.name).toBe('clip.mp4');
        expect(result.type).toBe('video/mp4');
        expect(result.size).toBe(300);
    });

    it('maps each attachment independently, in order', () => {
        const results = mapStreamAttachments([
            { fileId: 'a', name: 'a.png', type: 'image/png' },
            { fileId: 'b', name: 'b.png', type: 'image/png', generation: { creditsUsedMicro: '1', model: 'm' } },
        ]);

        expect(results).toHaveLength(2);
        expect(results[0].fileId).toBe('a');
        expect(results[0].generation).toBeUndefined();
        expect(results[1].fileId).toBe('b');
        expect(results[1].generation).toEqual({ creditsUsedMicro: '1', model: 'm' });
    });

    it('returns an empty array for an empty input', () => {
        expect(mapStreamAttachments([])).toEqual([]);
    });
});

describe('useChatStream message preparation', () => {
    it('blocks a second submission while an attachment URL is being prepared', async () => {
        let releasePresign!: (value: { presignedUrl: string }) => void;
        const presign = new Promise<{ presignedUrl: string }>(resolve => {
            releasePresign = resolve;
        });
        vi.spyOn(api, 'get').mockReturnValue(presign);
        vi.spyOn(api, 'patch').mockResolvedValue({});
        chatMock.sendMessage.mockResolvedValue();

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const conversationIdRef = { current: 'conversation-1' };
        const { result } = renderHook(() => useChatStream({
            conversationId: 'conversation-1',
            conversationIdRef,
            agentId: 'agent-1',
            selectedConversation: undefined,
            messages: [],
            handleCanvasUpdate: vi.fn(),
            openCanvas: vi.fn(),
        }), { wrapper });

        let firstSend!: Promise<void>;
        act(() => {
            firstSend = result.current.sendMessage('Make this ad', [{
                fileId: 'image-1',
                name: 'avatar.jpg',
                type: 'image/jpeg',
                size: 42,
            }]);
        });

        await waitFor(() => expect(result.current.isPreparingMessage).toBe(true));
        expect(client.getQueryData<{ data: unknown[] }>(['messages', 'conversation-1'])?.data).toHaveLength(1);

        await act(async () => {
            await result.current.sendMessage('Duplicate send');
        });
        expect(client.getQueryData<{ data: unknown[] }>(['messages', 'conversation-1'])?.data).toHaveLength(1);
        expect(chatMock.sendMessage).not.toHaveBeenCalled();

        await act(async () => {
            releasePresign({ presignedUrl: 'https://files.example/avatar.jpg' });
            await firstSend;
        });

        expect(result.current.isPreparingMessage).toBe(false);
        expect(chatMock.sendMessage).toHaveBeenCalledTimes(1);
        expect(chatMock.sendMessage).toHaveBeenCalledWith(
            'Make this ad',
            [expect.objectContaining({ fileId: 'image-1', presignedUrl: 'https://files.example/avatar.jpg' })],
            undefined,
            true,
        );
    });

    it('falls back to the creative-library-assets presign route when the tenant file lookup 404s', async () => {
        vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
            if (path.includes('/files/')) {
                // Matches the real shape of a 404 thrown by apps/web/lib/api.ts's
                // ApiError (status set from the response) — the implementation
                // gates its retry on this exact field, so a plain Error() here
                // would make this test pass without proving the 404-specific gate
                // works (it would also "pass" for a 403).
                const err = new Error('Not Found') as Error & { status?: number };
                err.status = 404;
                throw err;
            }
            if (path.includes('/creative-library-assets/')) {
                return { presignedUrl: 'https://library.example/avatar.jpg' };
            }
            throw new Error(`unexpected path ${path}`);
        });
        vi.spyOn(api, 'patch').mockResolvedValue({});
        chatMock.sendMessage.mockResolvedValue();

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const { result } = renderHook(() => useChatStream({
            conversationId: 'conversation-1',
            conversationIdRef: { current: 'conversation-1' },
            agentId: 'agent-1',
            selectedConversation: undefined,
            messages: [],
            handleCanvasUpdate: vi.fn(),
            openCanvas: vi.fn(),
        }), { wrapper });

        await act(async () => {
            await result.current.sendMessage('Make this ad', [{
                fileId: '8b6e9254-cc47-492c-bdc7-557ac6302e01',
                name: 'tech-presenter.jpg',
                type: 'image/jpeg',
                size: 42,
            }]);
        });

        // Real signature (see the call site in useChatStream.ts's sendMessage):
        // sendChatMessage(content, enriched, skillsUsed, isFirstMessage). This
        // test doesn't pass skillsUsed, so it's `undefined` here (not
        // expect.anything(), which rejects undefined) — and this is the first
        // turn of an untitled, empty conversation, so isFirstMessage is `true`.
        expect(chatMock.sendMessage).toHaveBeenCalledWith(
            'Make this ad',
            [expect.objectContaining({ presignedUrl: 'https://library.example/avatar.jpg' })],
            undefined,
            true,
        );
    });
});

describe('useChatStream generation confirm', () => {
    const conversationIdRef = { current: 'conversation-1' };

    function setup() {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        renderHook(() => useChatStream({
            conversationId: 'conversation-1',
            conversationIdRef,
            agentId: 'agent-1',
            selectedConversation: undefined,
            messages: [],
            handleCanvasUpdate: vi.fn(),
            openCanvas: vi.fn(),
        }), { wrapper });
        return client;
    }

    const pendingRequest = (client: QueryClient) =>
        client.getQueryData<{ data: Array<{ generationConfirmRequest?: Record<string, unknown> }> }>(['messages', 'conversation-1'])
            ?.data[0]?.generationConfirmRequest;

    it('stores the batch count on the pending request', () => {
        const client = setup();
        act(() => {
            chatMock.lastOptions!.onGenerationConfirmRequired!('conf-1', 'video_generation', 'google/gemini-omni-1.1-flash', 'Generate videos', undefined, 3);
        });
        expect(pendingRequest(client)).toMatchObject({ id: 'conf-1', status: 'pending', count: 3 });
    });

    it('omits count for a single-item request', () => {
        const client = setup();
        act(() => {
            chatMock.lastOptions!.onGenerationConfirmRequired!('conf-2', 'image_generation', 'gemini-3-pro-image-preview', 'Generate image');
        });
        expect(pendingRequest(client)).not.toHaveProperty('count');
    });
});

describe('useChatStream batch item progress', () => {
    function setup() {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        return renderHook(() => useChatStream({
            conversationId: 'conversation-1',
            conversationIdRef: { current: 'conversation-1' },
            agentId: 'agent-1',
            selectedConversation: undefined,
            messages: [],
            handleCanvasUpdate: vi.fn(),
            openCanvas: vi.fn(),
        }), { wrapper });
    }

    it('counts distinct settled items, not the highest index seen, when items arrive out of order', () => {
        const { result } = setup();
        act(() => {
            chatMock.lastOptions!.onToolCall!('generate_videos', 'tc-1', {});
        });
        // Item 2 (of 0,1,2) settles first — Promise.allSettled doesn't
        // preserve completion order, so a naive `index + 1` would show
        // "3 of 3" here even though only one item has actually finished.
        act(() => {
            chatMock.lastOptions!.onBatchItemProgress!('tc-1', 2, 3);
        });
        expect(result.current.activeToolCalls.get('tc-1')?.batchProgress).toEqual({ done: 1, total: 3 });

        act(() => {
            chatMock.lastOptions!.onBatchItemProgress!('tc-1', 0, 3);
        });
        expect(result.current.activeToolCalls.get('tc-1')?.batchProgress).toEqual({ done: 2, total: 3 });

        // A duplicate event for an already-seen index must not double-count.
        act(() => {
            chatMock.lastOptions!.onBatchItemProgress!('tc-1', 2, 3);
        });
        expect(result.current.activeToolCalls.get('tc-1')?.batchProgress).toEqual({ done: 2, total: 3 });
    });

    it('attaches progress to the delegate wrapper call when the inner batch call id is unknown to the browser', () => {
        const { result } = setup();
        act(() => {
            chatMock.lastOptions!.onToolCall!('agent-director', 'tc-delegate', {});
        });
        act(() => {
            chatMock.lastOptions!.onBatchItemProgress!('inner-batch-id', 1, 4);
        });
        expect(result.current.activeToolCalls.get('tc-delegate')?.batchProgress).toEqual({ done: 1, total: 4 });
        expect(result.current.activeToolCalls.has('inner-batch-id')).toBe(false);
    });
});

describe('useChatStream conversation-switch trace reset', () => {
    // Regression for the 8th live-test bug: a run suspended on
    // ask_clarifying_questions never emits 'done', so the only place that used
    // to clear activeToolCalls/completedToolCalls/reasoningText was the 1500ms
    // settle-timeout after 'done' — which never fired. Switching conversations
    // mid-run left the previous conversation's whole tool trace showing on top
    // of the new conversation's "Working for Ns" indicator.
    function setup(conversationId: string) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const conversationIdRef = { current: conversationId };
        const view = renderHook(
            (props: { conversationId: string }) => {
                conversationIdRef.current = props.conversationId;
                return useChatStream({
                    conversationId: props.conversationId,
                    conversationIdRef,
                    agentId: 'agent-1',
                    selectedConversation: undefined,
                    messages: [],
                    handleCanvasUpdate: vi.fn(),
                    openCanvas: vi.fn(),
                });
            },
            { wrapper, initialProps: { conversationId } },
        );
        return { client, conversationIdRef, ...view };
    }

    it('clears completedToolCalls/activeToolCalls/reasoning when conversationId changes', () => {
        const { result, rerender } = setup('conversation-A');

        act(() => {
            chatMock.lastOptions!.onToolCall!('generate_image', 'tc-1', {});
        });
        act(() => {
            chatMock.lastOptions!.onReasoning!('thinking about it...');
        });
        expect(result.current.activeToolCalls.size).toBe(1);
        expect(result.current.reasoningText).not.toBe('');

        rerender({ conversationId: 'conversation-B' });

        expect(result.current.activeToolCalls.size).toBe(0);
        expect(result.current.completedToolCalls).toEqual([]);
        expect(result.current.reasoningText).toBe('');
        expect(result.current.traceAfterSeq).toBeNull();
    });

    it('a pending reset timer from conversation A does not wipe conversation B\'s trace', () => {
        vi.useFakeTimers();
        try {
            const { result, rerender } = setup('conversation-A');

            act(() => {
                chatMock.lastOptions!.onToolCall!('generate_image', 'tc-1', {});
                chatMock.lastOptions!.onToolDone!('tc-1', 'generate_image', {});
            });
            // Fires the 'done' handler for conversation A, which schedules the
            // 1500ms settle-timeout still pending when we switch below.
            act(() => {
                chatMock.lastOptions!.onDone!('done text', 'msg-1', 'conversation-A');
            });

            rerender({ conversationId: 'conversation-B' });

            // Conversation B starts its own run with a live tool call.
            act(() => {
                chatMock.lastOptions!.onToolCall!('generate_video', 'tc-2', {});
            });
            expect(result.current.activeToolCalls.size).toBe(1);

            // Let conversation A's stale 1500ms timer fire.
            act(() => {
                vi.advanceTimersByTime(1600);
            });

            // Conversation B's live trace must survive the stale timer.
            expect(result.current.activeToolCalls.size).toBe(1);
            expect(result.current.activeToolCalls.has('tc-2')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
