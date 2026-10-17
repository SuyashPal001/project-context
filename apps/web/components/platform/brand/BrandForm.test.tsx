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

    it('has no Emoji row on the Voice tab (set from the import or from chat)', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
        expect(screen.getByText('Tone words')).toBeTruthy();
        expect(screen.queryByText('Emoji')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Minimal' })).toBeNull();
    });

    it('shows where the brand came from', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        expect(screen.getByText(/Filled from mamaearth\.in · today/)).toBeTruthy();
    });

    // The colour picker itself (native input vs. react-colorful card, drag
    // ticks, unset-swatch-never-saves-white guarantees) is covered in
    // BrandColorField.test.tsx. This file keeps only the resting-row basics.
    it('shows the Colours row with the set role and the others "Not set"', () => {
        render(<BrandForm {...baseProps} brand={brand} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
        expect(screen.getByText('#00A651')).toBeTruthy();
        expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
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
