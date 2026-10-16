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

describe('BrandForm', () => {
    it('shows readiness ticks and what is missing', () => {
        render(<BrandForm brand={brand} onSave={vi.fn()} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect(screen.getByText(/Olmo needs three things to write like Mamaearth/)).toBeTruthy();
        expect(screen.getByTestId('ready-audience').getAttribute('data-done')).toBe('false');
        expect(screen.getByTestId('ready-name').getAttribute('data-done')).toBe('true');
    });

    it('saves a text field on blur, only when it changed', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const audience = screen.getByLabelText('Audience');
        fireEvent.blur(audience);
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.change(audience, { target: { value: 'Women in Indian cities' } });
        fireEvent.blur(audience);
        expect(onSave).toHaveBeenCalledWith({ audience: 'Women in Indian cities' });
    });

    it('saves a list field one item per line', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const banned = screen.getByLabelText('Banned phrases');
        fireEvent.change(banned, { target: { value: 'cheap\n\n literally ' } });
        fireEvent.blur(banned);
        expect(onSave).toHaveBeenCalledWith({ bannedPhrases: ['cheap', 'literally'] });
    });

    it('saves a region chip immediately', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'UAE' }));
        expect(onSave).toHaveBeenCalledWith({ region: 'AE' });
    });

    it('shows where the brand came from', () => {
        render(<BrandForm brand={brand} onSave={vi.fn()} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect(screen.getByText(/Filled from mamaearth\.in · today/)).toBeTruthy();
    });

    // Fix round 1, item 2: <input type="color"> fires React's onChange — bound
    // to the native `input` event — once per drag tick while the OS picker is
    // open. A PATCH per tick would hammer the API, so only the native `change`
    // event (or blur) should save, and only when the value actually differs.
    it('does not save on every colour drag tick — only on the native change/blur, and only once', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
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
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const swatch = screen.getByLabelText('accent colour') as HTMLInputElement;
        fireEvent.focus(swatch);
        fireEvent.blur(swatch, { target: { value: '#FFFFFF' } });
        expect(onSave).not.toHaveBeenCalled();
    });

    it('saves an unset colour once the user picks one', () => {
        const onSave = vi.fn();
        render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        const swatch = screen.getByLabelText('accent colour') as HTMLInputElement;
        fireEvent.input(swatch, { target: { value: '#123456' } });
        fireEvent.blur(swatch);
        expect(onSave).toHaveBeenCalledWith({ colors: { primary: '#00A651', accent: '#123456' } });
    });

    it('syncs the font field when the prop changes (e.g. after Refresh/import), unlike an uncontrolled input', () => {
        const onSave = vi.fn();
        const { rerender } = render(<BrandForm brand={brand} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect((screen.getByLabelText('Font') as HTMLInputElement).value).toBe('Poppins');

        rerender(<BrandForm brand={{ ...brand, headlineFont: 'Inter' }} onSave={onSave} onRefresh={vi.fn()} onUploadImage={vi.fn()} refreshing={false} />);
        expect((screen.getByLabelText('Font') as HTMLInputElement).value).toBe('Inter');
    });
});
