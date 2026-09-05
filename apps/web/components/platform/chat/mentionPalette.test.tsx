/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...args: unknown[]) => apiGet(...args) } }));

import { MentionPalette } from './MentionPalette';

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const AGENT = {
    id: 'agent-1', name: 'Product Manager', status: 'active',
    type: 'supervisor', description: 'Runs the PM workflow',
    persona: null, avatarUrl: null,
};

const noopProps = { onSelect: vi.fn(), onClose: vi.fn(), onSwitchToSlash: vi.fn() };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('MentionPalette', () => {
    it('lists active AI employees and never mentions skills', async () => {
        apiGet.mockResolvedValue({ data: [AGENT] });
        render(<MentionPalette query="" {...noopProps} />);

        expect(await screen.findByText('Product Manager')).toBeTruthy();
        expect(screen.queryByText(/skill/i)).toBeNull();
    });

    it('hides employees that are not active', async () => {
        apiGet.mockResolvedValue({ data: [{ ...AGENT, status: 'archived' }] });
        render(<MentionPalette query="" {...noopProps} />);

        expect(await screen.findByText(/No AI employees match/)).toBeTruthy();
    });

    // Mirror of SlashPalette's hint — a dead end on one key is what makes people
    // expect the other key's contents to live here.
    it('cross-hints to "/" instead of listing skills when nothing matches', async () => {
        apiGet.mockResolvedValue({ data: [AGENT] });
        const onSwitchToSlash = vi.fn();
        render(<MentionPalette query="zzz" {...noopProps} onSwitchToSlash={onSwitchToSlash} />);

        const hint = await screen.findByText(/Looking for a skill/);
        await userEvent.click(hint);
        expect(onSwitchToSlash).toHaveBeenCalledOnce();
    });

    // The widget composer cannot open "/" at all, so the hint must not appear
    // there — advertising a key that does nothing is worse than no hint.
    it('omits the "/" hint when no handler is supplied', async () => {
        apiGet.mockResolvedValue({ data: [AGENT] });
        render(<MentionPalette query="zzz" onSelect={vi.fn()} onClose={vi.fn()} />);

        await screen.findByText(/No AI employees match/);
        expect(screen.queryByText(/Looking for a skill/)).toBeNull();
    });
});
