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
}));

vi.mock('@/hooks/useChat', () => ({
    useChat: () => ({
        sendMessage: chatMock.sendMessage,
        sendApproval: vi.fn(),
        sendGenerationConfirm: vi.fn(),
        sendClarificationAnswer: vi.fn(),
        sendUploadAnswer: vi.fn(),
        cancel: chatMock.cancel,
        isStreaming: false,
        isRetrying: false,
    }),
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
