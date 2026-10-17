/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BrandForm } from './BrandForm';
import type { BrandRecord } from './brandApi';

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

const brand: BrandRecord = {
    name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women in Indian cities', region: 'IN', toneWords: ['warm'],
    emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: ['Shop now'], voiceNotes: null,
    colors: {}, headlineFont: null, logo: null, favicon: null, mascot: null, font: null, fontName: null,
    sourceType: null, sourceValue: null, importStatus: 'idle', importedAt: null,
    ready: true, missing: [], updatedAt: new Date().toISOString(),
};

const OCEAN = { primary: '#2F6F8F', secondary: '#23495A', accent: '#E8A33D', text: '#111827', background: '#EEF6FD', muted: '#6B7280' };

const baseProps = {
    onSave: vi.fn(), onRefresh: vi.fn(), onUploadImage: vi.fn(), refreshing: false,
};

function renderVisuals(onSave = vi.fn(), brandRecord: BrandRecord = brand, onUploadImage = vi.fn()) {
    render(<BrandForm {...baseProps} brand={brandRecord} onSave={onSave} onUploadImage={onUploadImage} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Visuals' }));
    return { onSave, onUploadImage };
}

describe('logo and mascot tiles', () => {
    it('shows the empty copy and an Upload button for an unset logo', () => {
        renderVisuals();
        expect(screen.getByText('No logo yet. Add one, or go without.')).toBeTruthy();
        const logoRow = screen.getByText('Logo').closest('.rounded-xl') as HTMLElement;
        expect(within(logoRow).getByRole('button', { name: 'Upload' })).toBeTruthy();
        expect(within(logoRow).queryByRole('button', { name: 'Remove' })).toBeNull();
    });

    it('shows Replace and Remove for a set logo', () => {
        renderVisuals(vi.fn(), { ...brand, logo: { fileId: 'f1', url: 'https://x/logo.png' } });
        const logoRow = screen.getByText('Logo').closest('.rounded-xl') as HTMLElement;
        expect(within(logoRow).getByRole('button', { name: 'Replace' })).toBeTruthy();
        expect(within(logoRow).getByRole('button', { name: 'Remove' })).toBeTruthy();
    });

    it('marks the mascot tile Optional', () => {
        renderVisuals();
        expect(screen.getByText('Optional')).toBeTruthy();
        expect(screen.getByText('Upload one if your brand has a character.')).toBeTruthy();
    });

    it('always renders a visible Upload button on every unset tile', () => {
        renderVisuals();
        for (const title of ['Logo', 'Favicon', 'Mascot']) {
            const tile = screen.getByText(title).closest('.rounded-xl') as HTMLElement;
            expect(within(tile).getByRole('button', { name: 'Upload' })).toBeTruthy();
        }
    });
});

function coloursSection() {
    return screen.getByText('Pick a palette, set your own, or leave it to Olmo.').closest('div')!.parentElement!;
}
function typographySection() {
    return screen.getByText('Pick your brand font, or let Olmo choose.').closest('div')!.parentElement!;
}

describe('colour palettes', () => {
    it('selects "Olmo picks" when no colours are set', () => {
        renderVisuals();
        expect(within(coloursSection()).getByRole('button', { name: /Olmo picks/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('clicking Ocean saves all six Ocean colours in one patch', () => {
        const { onSave } = renderVisuals();
        fireEvent.click(within(coloursSection()).getByRole('button', { name: /Ocean/ }));
        expect(onSave).toHaveBeenCalledWith({ colors: OCEAN });
    });

    it('a brand whose saved colours equal Ocean shows Ocean selected', () => {
        renderVisuals(vi.fn(), { ...brand, colors: OCEAN });
        expect(within(coloursSection()).getByRole('button', { name: /Ocean/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('clicking "Olmo picks" sends all six roles null', () => {
        const { onSave } = renderVisuals(vi.fn(), { ...brand, colors: OCEAN });
        fireEvent.click(within(coloursSection()).getByRole('button', { name: /Olmo picks/ }));
        expect(onSave).toHaveBeenCalledWith({
            colors: { primary: null, secondary: null, accent: null, text: null, background: null, muted: null },
        });
    });
});

describe('live preview', () => {
    it('renders the headline sample', () => {
        renderVisuals();
        expect(screen.getByText('Your headline here')).toBeTruthy();
    });
});

describe('font cards', () => {
    it('selects "Olmo picks" when headlineFont is null', () => {
        renderVisuals();
        expect(within(typographySection()).getByRole('button', { name: /Olmo picks/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('clicking Poppins saves headlineFont and clears any upload', () => {
        const { onSave } = renderVisuals();
        fireEvent.click(within(typographySection()).getByRole('button', { name: /Poppins/ }));
        expect(onSave).toHaveBeenCalledWith({ headlineFont: 'Poppins', fontFileId: null });
    });

    it('a custom font selects "Other font" and shows it in the card subtitle', () => {
        renderVisuals(vi.fn(), { ...brand, headlineFont: 'Comic Sans MS' });
        const other = screen.getByRole('button', { name: /Other font/ });
        expect(other.getAttribute('aria-pressed')).toBe('true');
        expect(within(other).getByText('Comic Sans MS')).toBeTruthy();
    });
});
