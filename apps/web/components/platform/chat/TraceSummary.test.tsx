/** @vitest-environment jsdom */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceSummary } from './TraceSummary';
import type { CompletedToolCall } from './types';

afterEach(() => cleanup());

const imageCall: CompletedToolCall = {
    id: 't1',
    toolName: 'generate_image',
    query: '',
    result: { fileId: 'f1', name: 'a.png', fileType: 'image/png' },
};
const searchCall: CompletedToolCall = {
    id: 't2',
    toolName: 'web_search',
    query: 'brief',
    results: [],
};

describe('TraceSummary collapse', () => {
    it('labels the collapsed row with the step count', () => {
        render(<TraceSummary elapsedSec={9} toolCalls={[imageCall, searchCall]} />);
        expect(screen.getByText('Worked for 9s · 2 steps')).toBeTruthy();
    });

    it('uses the singular "step" for exactly one tool call', () => {
        render(<TraceSummary elapsedSec={3} toolCalls={[imageCall]} />);
        expect(screen.getByText('Worked for 3s · 1 step')).toBeTruthy();
    });

    it('heads a part that only searched by the sources it read', () => {
        const withSources = { ...searchCall, results: [{ title: 'a', domain: 'a.com' }, { title: 'b', domain: 'b.com' }] };
        render(<TraceSummary elapsedSec={3} toolCalls={[withSources]} />);
        expect(screen.getByText('Searched the web · 2 sources')).toBeTruthy();
    });

    it('heads a part that only thought by how long it thought', () => {
        render(<TraceSummary elapsedSec={6} toolCalls={[]} reasoningText="Plan the scenes." reasoningElapsedSec={4} />);
        expect(screen.getByText('Thought for 4s')).toBeTruthy();
    });

    it('names what a part made', () => {
        render(<TraceSummary elapsedSec={40} toolCalls={[imageCall]} made={{ pictures: 1, clips: 2 }} />);
        expect(screen.getByText('Worked for 40s · 1 step · 1 picture, 2 clips')).toBeTruthy();
    });

    it('keeps a completed generation visible even while the rest of the trace is collapsed', () => {
        render(<TraceSummary elapsedSec={9} toolCalls={[imageCall, searchCall]} freshUrls={{ f1: 'https://x/a.png' }} />);
        // Collapsed by default — the image tile is still on the page...
        expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy();
        // ...but the non-media step ("Searched the web for...") is hidden.
        expect(screen.queryByText(/Searched the web/)).toBeNull();
    });
});

describe('TraceSummary order', () => {
    it('puts "Worked for" above the pictures the part made', () => {
        render(<TraceSummary elapsedSec={9} toolCalls={[imageCall, searchCall]} freshUrls={{ f1: 'https://x/a.png' }} />);
        const header = screen.getByText(/^Worked for 9s/);
        const picture = screen.getByRole('img', { name: 'a.png' });
        expect(header.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
