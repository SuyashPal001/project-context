// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Canvas } from './Canvas';

vi.mock('@/lib/api', () => ({
    api: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn(), delete: vi.fn() },
}));

function renderCanvas() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <Canvas isOpen tenantSlug="acme" flushPending={() => { }} conversationId="conv-1" />
        </QueryClientProvider>,
    );
}

describe('Canvas home tab', () => {
    beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })); });

    // The Knowledge Base used to be the canvas's home tab. It moved out to dev
    // studio because it is an admin surface, and Chat History took its place —
    // the conversation's own files, which is what a user actually wants here.
    it('opens on Chat History', () => {
        renderCanvas();
        // Rendered in both the tab strip and the gallery's own header, so
        // assert presence rather than uniqueness.
        expect(screen.getAllByText('Chat History').length).toBeGreaterThan(0);
    });

    it('no longer offers a Knowledge Base tab', () => {
        renderCanvas();
        expect(screen.queryByText('Knowledge Base')).toBeNull();
    });
});
