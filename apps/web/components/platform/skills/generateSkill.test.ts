/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSkill, SkillGenerationError } from './generateSkill';

function sseResponse(frames: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
        },
    });
    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const INPUT = { name: 'Bid Writer', brief: 'Help write RFP responses' };

describe('generateSkill', () => {
    beforeEach(() => {
        document.cookie = 'platform_id_token=test-token';
    });
    afterEach(() => vi.restoreAllMocks());

    it('accumulates delta events into the full draft', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"text":"---\\nname: bid-writer\\n"}\n\n',
            'event: delta\ndata: {"text":"description: d\\n---\\n\\nBody."}\n\n',
            'event: done\ndata: {"model":"gemini-2.5-flash"}\n\n',
        ])));

        const seen: string[] = [];
        const draft = await generateSkill(INPUT, { onDelta: (t) => seen.push(t) });

        expect(seen).toHaveLength(2);
        expect(draft).toBe('---\nname: bid-writer\ndescription: d\n---\n\nBody.');
    });

    // A delta split across two network chunks must not be parsed as two events
    // or dropped — the buffer only yields on a complete \n\n frame.
    it('handles an event split across chunk boundaries', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"te',
            'xt":"hello"}\n\nevent: done\ndata: {}\n\n',
        ])));

        const draft = await generateSkill(INPUT, { onDelta: () => {} });
        expect(draft).toBe('hello');
    });

    it('throws NO_CREDITS on a 402', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 402 })));
        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toMatchObject({ code: 'NO_CREDITS' });
    });

    it('throws UNAUTHORIZED on a 401', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('throws FAILED when the stream sends an error event', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            'event: delta\ndata: {"text":"partial"}\n\n',
            'event: error\ndata: {"message":"Generation failed. Try again."}\n\n',
        ])));

        await expect(generateSkill(INPUT, { onDelta: () => {} }))
            .rejects.toBeInstanceOf(SkillGenerationError);
    });

    it('sends the previous draft and feedback when revising', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(['event: done\ndata: {}\n\n']));
        vi.stubGlobal('fetch', fetchMock);

        await generateSkill({ ...INPUT, previousDraft: 'old', feedback: 'shorter' }, { onDelta: () => {} });

        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({ previousDraft: 'old', feedback: 'shorter' });
        expect(init.headers.Authorization).toBe('Bearer test-token');
    });
});
