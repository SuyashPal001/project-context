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
});
