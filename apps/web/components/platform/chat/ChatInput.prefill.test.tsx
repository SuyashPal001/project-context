/** @vitest-environment jsdom */
// The Brand page's "Tell Olmo about your brand" link lands on the chat page
// with ?prefill=<text>, which the page seeds into inputPrefill once and hands
// to ChatInput as a prop. Fix round 1, item 1: that seed must be one-shot —
// once a message sends, the page clears inputPrefill to '', and no later
// ChatInput mount (a different view, the same composer remounting) should
// show the stale text again. ChatInput itself only reacts to a *truthy*
// prefill changing (see the effect at ChatInput.tsx:460-465), so these tests
// prove the two halves of that contract: sending clears the composer, and a
// prop that stays unchanged (or is '') never reseeds it.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from './ChatInput';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

beforeAll(() => {
    // jsdom has no scrollIntoView; ChatInput's textarea autofocus path calls it.
    Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => {} });
});

function getTextarea() {
    return screen.getByPlaceholderText(/ask anything/i) as HTMLTextAreaElement;
}

describe('ChatInput prefill — one-shot seeding', () => {
    it('is empty after a send, even though the prefill prop that seeded it is still set', () => {
        const onSend = vi.fn();
        const { rerender } = render(<ChatInput onSend={onSend} prefill="Set up my brand" />);
        expect(getTextarea().value).toBe('Set up my brand');

        fireEvent.click(screen.getByRole('button', { name: /send message/i }));
        expect(onSend).toHaveBeenCalledWith('Set up my brand', undefined, undefined);
        expect(getTextarea().value).toBe('');

        // The page hasn't re-rendered with a new prefill value yet (same prop,
        // unchanged) — the textarea must not jump back to the old text.
        rerender(<ChatInput onSend={onSend} prefill="Set up my brand" />);
        expect(getTextarea().value).toBe('');
    });

    it('a fresh mount with an already-cleared prefill (the page-level fix) never seeds stale text', () => {
        const onSend = vi.fn();
        const { unmount } = render(<ChatInput onSend={onSend} prefill="Set up my brand" />);
        expect(getTextarea().value).toBe('Set up my brand');
        unmount();
        cleanup();

        // Simulates the page clearing inputPrefill to '' (on send, or on a
        // conversationId change) before a different ChatInput — e.g. the
        // in-conversation composer the view switches to — mounts.
        render(<ChatInput onSend={onSend} prefill="" />);
        expect(getTextarea().value).toBe('');
    });

    it('does not seed at all when no prefill is passed', () => {
        render(<ChatInput onSend={vi.fn()} />);
        expect(getTextarea().value).toBe('');
    });
});
