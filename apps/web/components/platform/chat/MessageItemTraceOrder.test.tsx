/** @vitest-environment jsdom */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageItem } from './MessageItem';
import type { Message } from './types';

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

afterEach(() => cleanup());

const base: Message = {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Intro line.Final reply.',
    createdAt: '2026-09-25T10:00:00.000Z',
    parts: [
        { seq: 1, type: 'text', text: 'Intro line.' },
        { seq: 2, type: 'text', text: 'Final reply.' },
    ],
};

const renderItem = (message: Message) =>
    render(<MessageItem message={message} freshUrls={{}} creatingPlanId={null} planErrors={{}} onCreateInSystem={vi.fn()} />);

const position = (el: HTMLElement) => el.compareDocumentPosition.bind(el);

describe('MessageItem trace placement', () => {
    it('renders text that came before the first tool call ABOVE the trace, and the reply below it', () => {
        renderItem({
            ...base,
            completedTrace: {
                elapsedSec: 9,
                afterSeq: 1,
                toolCalls: [{ id: 't1', toolName: 'agent-director', arguments: {}, isLoading: false, query: '' }],
            },
        });
        const intro = screen.getByText('Intro line.');
        const reply = screen.getByText('Final reply.');
        const trace = screen.getByText(/Worked for 9s/);
        // DOCUMENT_POSITION_FOLLOWING (4): the argument comes after the receiver.
        expect(position(intro)(trace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(position(trace)(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the old order (trace first) when no anchor is recorded', () => {
        renderItem({
            ...base,
            completedTrace: { elapsedSec: 9, toolCalls: [{ id: 't1', toolName: 'agent-director', arguments: {}, isLoading: false, query: '' }] },
        });
        const intro = screen.getByText('Intro line.');
        const trace = screen.getByText(/Worked for 9s/);
        expect(position(trace)(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
