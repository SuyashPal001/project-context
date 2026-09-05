/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, act, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { Skill } from '@/components/platform/skills/types';

const listSkills = vi.fn();
vi.mock('@/components/platform/skills/actions', () => ({
    listSkills: (...args: unknown[]) => listSkills(...args),
}));

import { SlashPalette } from './SlashPalette';

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: 'skill-1',
        name: 'Blog Formatter',
        slug: 'blog-formatter',
        description: 'Formats drafts to house style',
        visibility: 'private',
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: 'tenant-1',
        ownerName: null,
        ownerEmail: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        installId: 'install-1',
        installedVersion: 2,
        installed: true,
        latestVersionStatus: 'ready',
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        ...overrides,
    };
}

const noopProps = { onSelect: vi.fn(), onClose: vi.fn(), onSwitchToMention: vi.fn() };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SlashPalette', () => {
    // The whole point of the split: "/" used to return agents under a "Skills
    // and AI employees" heading, which is what made employees reachable from
    // both keys and skills from neither.
    it('lists installed skills and never mentions employees', async () => {
        listSkills.mockResolvedValue([makeSkill()]);
        render(<SlashPalette query="" {...noopProps} />);

        expect(await screen.findByText('Blog Formatter')).toBeTruthy();
        expect(screen.getByText('Skills')).toBeTruthy();
        expect(screen.queryByText(/employee/i)).toBeNull();
    });

    it('asks for the tenant install library, not the skills it owns', async () => {
        listSkills.mockResolvedValue([]);
        render(<SlashPalette query="" {...noopProps} />);

        // "mine" filters on ownerTenantId, so a skill installed from the Public
        // or Official tab would silently never appear.
        await waitFor(() => expect(listSkills).toHaveBeenCalledWith('installed'));
    });

    it('filters on slug as well as name', async () => {
        listSkills.mockResolvedValue([makeSkill(), makeSkill({ id: 'skill-2', name: 'Tone Check', slug: 'tone-check' })]);
        render(<SlashPalette query="blog" {...noopProps} />);

        expect(await screen.findByText('Blog Formatter')).toBeTruthy();
        expect(screen.queryByText('Tone Check')).toBeNull();
    });

    it('hides skills the tenant has not installed', async () => {
        listSkills.mockResolvedValue([makeSkill({ installed: false, installId: null })]);
        render(<SlashPalette query="" {...noopProps} />);

        // Wait on the empty state, not on the absence of the name: a bare
        // waitFor(queryByText(...)).toBeNull() resolves on its first tick while
        // the query is still loading, so it passes even with the filter deleted.
        await screen.findByText(/No installed skills yet/);
        expect(screen.queryByText('Blog Formatter')).toBeNull();
    });

    it('cross-hints to "@" instead of listing employees when nothing matches', async () => {
        listSkills.mockResolvedValue([makeSkill()]);
        const onSwitchToMention = vi.fn();
        render(<SlashPalette query="zzz" {...noopProps} onSwitchToMention={onSwitchToMention} />);

        const hint = await screen.findByText(/Looking for an AI employee/);
        await userEvent.click(hint);
        expect(onSwitchToMention).toHaveBeenCalledOnce();
    });

    it('points at the Skills page when the install library is empty', async () => {
        listSkills.mockResolvedValue([]);
        render(<SlashPalette query="" {...noopProps} />);

        expect(await screen.findByText(/No installed skills yet/)).toBeTruthy();
    });

    it('selects the highlighted skill through the keyboard handle', async () => {
        listSkills.mockResolvedValue([makeSkill(), makeSkill({ id: 'skill-2', name: 'Tone Check', slug: 'tone-check' })]);
        const onSelect = vi.fn();
        const ref = { current: null } as React.RefObject<{ moveActive: (d: number) => void; selectActive: () => boolean } | null>;
        render(<SlashPalette ref={ref} query="" {...noopProps} onSelect={onSelect} />);

        await screen.findByText('Blog Formatter');
        // act(): moveActive sets state, and selectActive reads the index it
        // just set — without a flush it still sees the previous render's 0.
        act(() => ref.current?.moveActive(1));
        expect(ref.current?.selectActive()).toBe(true);
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill-2' }));
    });

    // Enter on an empty list must fall through to closing, not report a
    // selection — ChatInput relies on the false to avoid sending "/zzz" as chat.
    it('reports no selection when the filtered list is empty', async () => {
        listSkills.mockResolvedValue([makeSkill()]);
        const ref = { current: null } as React.RefObject<{ moveActive: (d: number) => void; selectActive: () => boolean } | null>;
        render(<SlashPalette ref={ref} query="zzz" {...noopProps} />);

        await screen.findByText(/Looking for an AI employee/);
        expect(ref.current?.selectActive()).toBe(false);
    });
});
