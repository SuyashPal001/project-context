/** @vitest-environment jsdom */

// Replays the event order of a real Ask-mode ad run (Lakmē, 2026-10-07) through
// the real stream hook and draws the real chat, then checks what the user can
// see. Unit tests that fed hand-made events passed while this run broke: the
// Director worked with no text from Olmo, so that part was hidden, pictures
// and all; rows open when the user answered showed up in the next part; and a
// run that broke left its rows behind. Each of those is a check here.

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStream } from './useChatStream';
import { MessageThread } from '@/components/platform/chat/MessageThread';
import type { Message, MessagesResponse } from '@/components/platform/chat/types';

const chatMock = vi.hoisted(() => ({ options: undefined as undefined | Record<string, (...args: unknown[]) => void> }));
vi.mock('@/hooks/useChat', () => ({
    useChat: (options: Record<string, (...args: unknown[]) => void>) => {
        chatMock.options = options;
        return { sendMessage: vi.fn(), sendApproval: vi.fn(), sendGenerationConfirm: vi.fn(), sendClarificationAnswer: vi.fn(), sendUploadAnswer: vi.fn(), cancel: vi.fn(), isStreaming: true, isRetrying: false };
    },
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({ presignedUrl: 'https://files.example/x' }), post: vi.fn() } }));
vi.mock('@/app/[tenant]/tenant-provider', () => ({ useTenant: () => ({ tenantId: 'tenant-1', userId: 'user-1' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useParams: () => ({ tenant: 'acme' }) }));
vi.mock('@/hooks/useAssetThumbnail', () => ({ useThumbnailUrl: () => undefined }));
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));
vi.mock('@/components/platform/chat/AgentOrb', () => ({ AgentOrb: () => <span /> }));
vi.mock('@/components/platform/credits/ApproveCost', () => ({ ApproveCost: () => <div data-testid="approve-cost" /> }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const CONV = 'conv-lakme';
const conversationIdRef = { current: CONV };
const ev = () => chatMock.options!;
let now = 1_000_000;
const tick = (ms = 1000) => { now += ms; vi.setSystemTime(now); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = 1_000_000;
    vi.setSystemTime(now);
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<MessagesResponse>(['messages', CONV], { data: [
        { id: 'u1', conversationId: CONV, role: 'user', content: 'Make a UGC ad for Lakmē Forever Matte', createdAt: new Date(now).toISOString() },
    ] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useChatStream({
        conversationId: CONV, conversationIdRef, agentId: 'olmo', selectedConversation: undefined, messages: [],
        handleCanvasUpdate: vi.fn(), openCanvas: vi.fn(),
    }), { wrapper });
    // Only the drawn chat is replaced between looks; cleanup() would also
    // unmount the stream hook and freeze its state.
    let view: ReturnType<typeof render> | null = null;
    const draw = () => {
        view?.unmount();
        const live = hook.result.current;
        const messages = client.getQueryData<MessagesResponse>(['messages', CONV])!.data;
        view = render(
            <QueryClientProvider client={client}>
                <MessageThread
                    messages={messages}
                    isStreaming
                    activeToolCalls={[...live.activeToolCalls.values()]}
                    completedToolCalls={live.completedToolCalls}
                    liveSteps={live.liveSteps}
                    reasoningText={live.reasoningText}
                    traceAfterSeq={live.traceAfterSeq}
                />
            </QueryClientProvider>,
        );
        return view;
    };
    // What the page does when the user answers a card: the request settles in the cache.
    const answerCard = (clarificationId: string) => client.setQueryData<MessagesResponse>(['messages', CONV], old => ({
        data: old!.data.map((m: Message) => ({ ...m, clarificationRequests: m.clarificationRequests?.map(r => r.id === clarificationId ? { ...r, status: 'answered' as const, answers: { 0: { selectedIndex: 0 } } } : r) })),
    }));
    const decideCost = (confirmationId: string) => client.setQueryData<MessagesResponse>(['messages', CONV], old => ({
        data: old!.data.map((m: Message) => m.generationConfirmRequest?.id === confirmationId ? { ...m, generationConfirmRequest: { ...m.generationConfirmRequest, status: 'approved' as const } } : m),
    }));
    return { draw, answerCard, decideCost, hook };
}

describe('replay: Lakmē ad in Ask mode', () => {
    it('shows each part with what it made, each answer as the user\'s message, and nothing carried between parts', () => {
        const { draw, answerCard, decideCost, hook } = setup();

        // Part 1 — Olmo thinks, then writes the plan and asks for the cost.
        act(() => {
            tick(); ev().onReasoning('Lakmē bullet, three scenes, a mirror selfie to open.');
            tick(); ev().onDelta('Here is the plan: 3 scenes, 15s.', 'part-1');
            tick(); ev().onGenerationConfirmRequired('conf-1', 'image_generation', 'img', 'Generate image');
            ev().onTurnPause('part-1', { text: 'Here is the plan: 3 scenes, 15s.', elapsedSec: 3 });
        });
        act(() => { tick(); decideCost('conf-1'); ev().onTurnResume({ text: 'Approve' }); });

        // Part 2 — the Director works with no text from Olmo: thinking, the
        // Pictures step, the still, then the review question.
        act(() => {
            tick(); ev().onToolCall('agent-director', 'dir-1', { prompt: 'Scene 1 still' });
            ev().onReasoning('Scene 1: Tara at the bathroom mirror, bullet near the lips.');
            ev().onStep({ id: 's-1', key: 'pictures', label: 'Pictures', kind: 'image', state: 'running', count: 1, detail: 'Scene 1 still' });
        });
        // While it works: thinking is open, and the Director's own row is not repeated.
        draw();
        expect(screen.getByText(/bullet near the lips/)).toBeTruthy();
        expect(screen.queryByText(/Preparing your image/)).toBeNull();
        expect(screen.getByLabelText('being made')).toBeTruthy();

        act(() => {
            tick(20_000); ev().onToolCall('generate_image', 'sub-g1', {});
            ev().onToolDone('sub-g1', 'generate_image', { fileId: 'still-1', name: 'Scene 1 still.png', fileType: 'image/png' });
            ev().onStep({ id: 's-1', key: 'pictures', label: 'Pictures', kind: 'image', state: 'done', count: 1, detail: 'Scene 1 still', files: [{ fileId: 'still-1', name: 'Scene 1 still.png', type: 'image/png' }] });
            ev().onToolDone('dir-1', 'agent-director', { text: '' });
            tick(); ev().onToolCall('review_shots', 'rev-1', { kind: 'still' });
            ev().onClarificationRequired('cl-1', [{ prompt: 'Does Scene 1 look right?', options: [{ label: 'Looks good — continue (Recommended)' }, { label: 'Fix it' }] }], 'part-2');
            // The server hands the work over in one line when Olmo wrote nothing (handoverLine).
            ev().onDelta("Here's Scene 1 still.", 'part-2');
            ev().onTurnPause('part-2', { text: '', attachments: [{ fileId: 'still-1', name: 'Scene 1 still.png', type: 'image/png', size: 1 }] });
        });
        // While the review card is open (2026-10-07: the silent part was hidden
        // here, so the still being asked about was nowhere on screen).
        draw();
        expect(screen.getAllByText(/Scene 1 still\.png/).length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText(/Preparing your image/)).toBeNull();

        act(() => { tick(); answerCard('cl-1'); ev().onTurnResume({ text: 'Looks good — continue' }); ev().onToolDone('rev-1', 'review_shots', {}); });
        // Part 3 — a run that breaks mid-way, then the user carries on.
        act(() => {
            tick(); ev().onToolCall('agent-director', 'dir-2', { prompt: 'Scenes 2 and 3' });
            ev().onStep({ id: 's-2', key: 'pictures', label: 'Pictures', kind: 'image', state: 'running', count: 2 });
            ev().onError('STREAM_ERROR', 'Something went wrong mid-run.');
        });
        expect([...hook.result.current.activeToolCalls.keys()]).toEqual([]);
        expect(hook.result.current.liveSteps).toHaveLength(0);

        // Part 4 — the finished ad.
        act(() => {
            tick(); ev().onToolCall('agent-director', 'dir-3', { prompt: 'Join' });
            ev().onStep({ id: 's-3', key: 'join', label: 'Joining the scenes', kind: 'join', state: 'running', count: 1 });
            tick(30_000); ev().onStep({ id: 's-3', key: 'join', label: 'Joining the scenes', kind: 'join', state: 'done', count: 1, files: [{ fileId: 'ad-1', name: 'Lakmē ad.mp4', type: 'video/mp4' }] });
            ev().onToolDone('dir-3', 'agent-director', { text: '' });
            ev().onDelta('Done — Lakmē ad', 'part-4');
            ev().onDone('Done — Lakmē ad', 'part-4', CONV, undefined, undefined, undefined, undefined, [{ fileId: 'ad-1', name: 'Lakmē ad.mp4', type: 'video/mp4', size: 9 }]);
        });

        draw();
        // Every answer is the user's own message.
        for (const answer of ['Approve', 'Looks good — continue']) expect(screen.getByText(answer)).toBeTruthy();
        // The plan part keeps its text. A question is asked once, on its card:
        // once answered it is not repeated in the chat.
        expect(screen.getByText('Here is the plan: 3 scenes, 15s.')).toBeTruthy();
        expect(screen.queryByText('Generate image?')).toBeNull();
        expect(screen.queryByText('Does Scene 1 look right?')).toBeNull();
        // The Director's part hands its work over: one line and the still as the
        // big output card. Folded, the part is just its "Worked for" line; the
        // still's small tile shows under its step once the part is opened.
        expect(screen.getByText("Here's Scene 1 still.")).toBeTruthy();
        expect(screen.getAllByText(/Scene 1 still\.png/).length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByLabelText('Scene 1 still.png')).toBeNull();
        // Nothing from a part leaks into the next, and the dead run left nothing behind.
        expect(screen.queryByText(/Preparing your image/)).toBeNull();
        expect(screen.queryByText(/Checked the scenes with you/)).toBeNull();
        // The finished ad is the big card at the end.
        expect(screen.getAllByText(/Lakmē ad\.mp4/).length).toBeGreaterThan(0);
        // Opened, the part shows its work: the still's tile under its step.
        for (const header of screen.getAllByText(/^Worked for/)) fireEvent.click(header.closest('button')!);
        expect(screen.getAllByLabelText('Scene 1 still.png')).toHaveLength(1);
    });

    it('a finished picture fills its step\'s tile even when the step never says done', () => {
        // 2026-10-07: "Pictures 0 of 2" kept two empty tiles while both stills
        // showed as loose "Image generated" cards below it.
        const { draw } = setup();
        act(() => {
            tick(); ev().onToolCall('agent-director', 'dir-9', { prompt: 'Scenes 2 and 3' });
            ev().onStep({ id: 's-9', key: 'pictures', label: 'Pictures', kind: 'image', state: 'running', count: 2, detail: 'Scene 2 +1' });
            tick(20_000);
            ev().onToolCall('generate_image', 'sub-a', {});
            ev().onToolDone('sub-a', 'generate_image', { fileId: 'still-2', name: 'Scene 2 still.png', fileType: 'image/png' });
        });
        draw();
        expect(screen.getAllByLabelText('Scene 2 still.png')).toHaveLength(1);
        expect(screen.getAllByLabelText('being made')).toHaveLength(1);
        expect(screen.queryByText(/Image generated/)).toBeNull();
        act(() => {
            ev().onToolCall('generate_image', 'sub-b', {});
            ev().onToolDone('sub-b', 'generate_image', { fileId: 'still-3', name: 'Scene 3 still.png', fileType: 'image/png' });
        });
        draw();
        expect(screen.getAllByLabelText(/Scene [23] still\.png/)).toHaveLength(2);
        expect(screen.queryByLabelText('being made')).toBeNull();
        expect(screen.queryByText(/Image generated/)).toBeNull();
    });
});
