/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandForm } from './BrandForm';
import type { BrandRecord } from './brandApi';

const brand: BrandRecord = {
    name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: null, region: 'IN', toneWords: ['warm'],
    emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: ['Shop now'], voiceNotes: null,
    colors: { primary: '#00A651' }, headlineFont: 'Poppins', logo: null, favicon: null, mascot: null,
    sourceType: 'website', sourceValue: 'https://mamaearth.in/', importStatus: 'done', importedAt: new Date().toISOString(),
    ready: false, missing: ['audience'], updatedAt: new Date().toISOString(),
};

const baseProps = {
    onSave: vi.fn(), onRefresh: vi.fn(), onUploadImage: vi.fn(), refreshing: false,
    chatHref: '/t/dashboard/chat?prefill=Set%20up%20my%20brand', onImport: vi.fn(), importing: false, importFailed: false,
};

describe('BrandForm', () => {
    it('shows a tick on Basics only once name and audience are both set', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByTestId('tab-basics').getAttribute('data-done')).toBe('false'); // audience missing
        render(<BrandForm {...baseProps} brand={{ ...brand, audience: 'Women in Indian cities' }} />);
        expect(screen.getAllByTestId('tab-basics').pop()!.getAttribute('data-done')).toBe('true');
    });

    it('shows a tick on Voice once there is at least one tone word, none otherwise', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByTestId('tab-voice').getAttribute('data-done')).toBe('true');
        render(<BrandForm {...baseProps} brand={{ ...brand, toneWords: [] }} />);
        expect(screen.getAllByTestId('tab-voice').pop()!.getAttribute('data-done')).toBe('false');
    });

    it('shows a tick on Look once a logo or a colour is set', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByTestId('tab-look').getAttribute('data-done')).toBe('true'); // has a colour
        render(<BrandForm {...baseProps} brand={{ ...brand, colors: {} }} />);
        expect(screen.getAllByTestId('tab-look').pop()!.getAttribute('data-done')).toBe('false');
    });

    it('defaults to the Basics tab and shows its fields', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByLabelText('Brand name')).toBeTruthy();
    });

    it('clicking a tab shows that section\'s fields', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.queryByLabelText('Banned phrases')).toBeNull();
        fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
        expect(screen.getByLabelText('Banned phrases')).toBeTruthy();
    });

    it('saves a text field on blur, only when it changed', () => {
        const onSave = vi.fn();
        render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        const audience = screen.getByLabelText('Audience');
        fireEvent.blur(audience);
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.change(audience, { target: { value: 'Women in Indian cities' } });
        fireEvent.blur(audience);
        expect(onSave).toHaveBeenCalledWith({ audience: 'Women in Indian cities' });
    });

    it('saves a list field one item per line', () => {
        const onSave = vi.fn();
        render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
        const banned = screen.getByLabelText('Banned phrases');
        fireEvent.change(banned, { target: { value: 'cheap\n\n literally ' } });
        fireEvent.blur(banned);
        expect(onSave).toHaveBeenCalledWith({ bannedPhrases: ['cheap', 'literally'] });
    });

    it('has no Region row or India chip', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.queryByText('Region')).toBeNull();
        expect(screen.queryByRole('button', { name: 'India' })).toBeNull();
    });

    it('shows where the brand came from', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByText(/Filled from mamaearth\.in · today/)).toBeTruthy();
    });

    // Fix round 1, item 2: <input type="color"> fires React's onChange — bound
    // to the native `input` event — once per drag tick while the OS picker is
    // open. A PATCH per tick would hammer the API, so only the native `change`
    // event (or blur) should save, and only when the value actually differs.
    it('does not save on every colour drag tick — only on the native change/blur, and only once', () => {
        const onSave = vi.fn();
        render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
        const swatch = screen.getByLabelText('primary colour') as HTMLInputElement;

        // Several live drag ticks: React's onChange prop fires (updates the
        // swatch + hex label), but nothing is saved yet.
        fireEvent.input(swatch, { target: { value: '#111111' } });
        fireEvent.input(swatch, { target: { value: '#222222' } });
        fireEvent.input(swatch, { target: { value: '#333333' } });
        expect(onSave).not.toHaveBeenCalled();

        // The picker closes on the settled colour: one native `change`.
        fireEvent.change(swatch, { target: { value: '#333333' } });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({ colors: { primary: '#333333' } });

        // A blur right after, for the same colour, must not double-save.
        fireEvent.blur(swatch, { target: { value: '#333333' } });
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('never saves white for an unset colour the user only focused and left', () => {
        const onSave = vi.fn();
        render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
        const swatch = screen.getByLabelText('accent colour') as HTMLInputElement;
        fireEvent.focus(swatch);
        fireEvent.blur(swatch, { target: { value: '#FFFFFF' } });
        expect(onSave).not.toHaveBeenCalled();
    });

    it('saves an unset colour once the user picks one', () => {
        const onSave = vi.fn();
        render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
        const swatch = screen.getByLabelText('accent colour') as HTMLInputElement;
        fireEvent.input(swatch, { target: { value: '#123456' } });
        fireEvent.blur(swatch);
        expect(onSave).toHaveBeenCalledWith({ colors: { primary: '#00A651', accent: '#123456' } });
    });

    it('syncs the font field when the prop changes (e.g. after Refresh/import), unlike an uncontrolled input', () => {
        const onSave = vi.fn();
        const { rerender } = render(<BrandForm {...baseProps} brand={brand} onSave={onSave} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
        expect((screen.getByLabelText('Font') as HTMLInputElement).value).toBe('Poppins');

        rerender(<BrandForm {...baseProps} brand={{ ...brand, headlineFont: 'Inter' }} onSave={onSave} />);
        expect((screen.getByLabelText('Font') as HTMLInputElement).value).toBe('Inter');
    });
});
