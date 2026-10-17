/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandPreviewCard, contrastRatio } from './BrandPreviewCard';
import type { BrandRecord } from './brandApi';

const BASE: BrandRecord = {
    name: 'Fitnearn', oneLiner: null, audience: null, region: 'IN', toneWords: [],
    emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null,
    colors: {}, headlineFont: null, logo: null, favicon: null, mascot: null, font: null, fontName: null,
    sourceType: null, sourceValue: null, importStatus: 'idle', importedAt: null,
    ready: false, missing: [], updatedAt: new Date().toISOString(),
};

describe('contrastRatio', () => {
    it('is ~21 for black on white', () => {
        expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    });

    it('is below 4.5 for a muddy dark-on-dark pair', () => {
        expect(contrastRatio('#1A1A1A', '#45493E')).toBeLessThan(4.5);
    });

    it('is 1 for identical colours', () => {
        expect(contrastRatio('#111827', '#111827')).toBeCloseTo(1, 1);
    });
});

describe('BrandPreviewCard', () => {
    it('shows the brand name and the sample headline', () => {
        render(<BrandPreviewCard brand={BASE} />);
        expect(screen.getAllByText('Fitnearn').length).toBeGreaterThan(0);
        expect(screen.getByText('Your headline here')).toBeTruthy();
    });

    it('shows the hard-to-read warning when text and background clash', () => {
        render(<BrandPreviewCard brand={{ ...BASE, colors: { text: '#1A1A1A', background: '#45493E' } }} />);
        expect(screen.getByText('Your text colour is hard to read on your background.')).toBeTruthy();
    });

    it('shows no warning for a readable pair', () => {
        render(<BrandPreviewCard brand={{ ...BASE, colors: { text: '#111827', background: '#FFFFFF' } }} />);
        expect(screen.queryByText('Your text colour is hard to read on your background.')).toBeNull();
    });

    it('shows the Olmo-picks caption when no colours are set', () => {
        render(<BrandPreviewCard brand={BASE} />);
        expect(screen.getByText('No brand colours yet — Olmo chooses them for you')).toBeTruthy();
    });

    it('shows "Preview with your colours" once a colour is set and it reads fine', () => {
        render(<BrandPreviewCard brand={{ ...BASE, colors: { primary: '#00A651' } }} />);
        expect(screen.getByText('Preview with your colours')).toBeTruthy();
    });

    it('renders the logo in the header avatar when one is set', () => {
        render(<BrandPreviewCard brand={{ ...BASE, logo: { fileId: 'f1', url: 'https://x/logo.png' } }} />);
        const img = screen.getByAltText('Logo') as HTMLImageElement;
        expect(img.src).toBe('https://x/logo.png');
    });

    it('renders the mascot inside the media area when one is set', () => {
        render(<BrandPreviewCard brand={{ ...BASE, mascot: { fileId: 'm1', url: 'https://x/mascot.png' } }} />);
        const img = screen.getByAltText('Mascot') as HTMLImageElement;
        expect(img.src).toBe('https://x/mascot.png');
    });

    it('tracks a live draft colour without needing it saved', () => {
        render(<BrandPreviewCard brand={BASE} draftColor={{ role: 'primary', hex: '#FF0000' }} />);
        expect(screen.getByTestId('brand-preview-cta').getAttribute('style')).toContain('rgb(255, 0, 0)');
    });
});
