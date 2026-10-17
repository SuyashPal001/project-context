/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { toast } from 'sonner';
import { BrandForm } from './BrandForm';
import type { BrandRecord } from './brandApi';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

const brand: BrandRecord = {
    name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women in Indian cities', region: 'IN', toneWords: ['warm'],
    emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: ['Shop now'], voiceNotes: null,
    colors: { primary: '#00A651' }, headlineFont: 'Poppins', logo: null, favicon: null, mascot: null,
    sourceType: 'website', sourceValue: 'https://mamaearth.in/', importStatus: 'done', importedAt: new Date().toISOString(),
    ready: true, missing: [], updatedAt: new Date().toISOString(),
};

const baseProps = {
    onSave: vi.fn(), onRefresh: vi.fn(), onUploadImage: vi.fn(), refreshing: false,
};

function renderLook(onSave = vi.fn(), brandRecord = brand) {
    render(<BrandForm {...baseProps} brand={brandRecord} onSave={onSave} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Visuals' }));
    return onSave;
}

beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('brand colour fields', () => {
    it('shows role name and uppercase hex for a set colour, "Olmo picks" for unset', () => {
        renderLook();
        expect(screen.getByText('primary')).toBeTruthy();
        expect(screen.getByText('#00A651')).toBeTruthy();
        expect(screen.getByText('secondary')).toBeTruthy();
        expect(screen.getAllByText('Olmo picks').length).toBeGreaterThan(0);
    });

    it('shows a copy button only for a set colour, and copies its hex', async () => {
        renderLook();
        const copyPrimary = screen.getByLabelText('Copy primary hex');
        expect(copyPrimary).toBeTruthy();
        expect(screen.queryByLabelText('Copy secondary hex')).toBeNull();

        fireEvent.click(copyPrimary);
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('#00A651');
        expect(toast.success).toHaveBeenCalledWith('Copied #00A651');
    });

    it('typing a short hex and pressing Enter saves the expanded, uppercased value', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit primary colour'));
        const hexInput = screen.getByLabelText('primary hex value');
        fireEvent.change(hexInput, { target: { value: '0a6' } });
        fireEvent.keyDown(hexInput, { key: 'Enter' });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({ colors: { primary: '#00AA66' } });
    });

    it('typing an invalid hex then closing does not save', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit primary colour'));
        const hexInput = screen.getByLabelText('primary hex value');
        fireEvent.change(hexInput, { target: { value: 'zzz' } });
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onSave).not.toHaveBeenCalled();
    });

    it('opening an unset role and closing without changes does not save', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit secondary colour'));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onSave).not.toHaveBeenCalled();
    });

    it('clicking a "From your brand" swatch then Done saves that colour for the opened role', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit secondary colour'));
        fireEvent.click(screen.getByLabelText('Use primary colour'));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({ colors: { primary: '#00A651', secondary: '#00A651' } });
    });

    it('dragging the picker only updates the draft, Done commits once', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit secondary colour'));
        const swatches = screen.getAllByLabelText('Use primary colour');
        // Simulate a couple of intermediate "drags" via the From-your-brand swatch
        // standing in for picker drag ticks — no save until Done.
        fireEvent.click(swatches[0]);
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('a set role\'s picker has a Clear button that sends that role as null', () => {
        const onSave = renderLook();
        fireEvent.click(screen.getByLabelText('Edit primary colour'));
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0].colors.primary).toBeNull();
    });

    it('an unset role\'s picker has no Clear button', () => {
        renderLook();
        fireEvent.click(screen.getByLabelText('Edit secondary colour'));
        expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    });
});

describe('picker footer layout', () => {
    it('"From your brand" and the swatches sit on one row, Clear/Done on another that does not contain the swatches', () => {
        renderLook();
        // secondary is unset; primary ('#00A651') is the only other brand
        // colour, so opening secondary shows exactly one "from your brand" swatch.
        fireEvent.click(screen.getByLabelText('Edit secondary colour'));
        const label = screen.getByText('From your brand');
        const row = label.parentElement as HTMLElement;
        expect(within(row).getByLabelText('Use primary colour')).toBeTruthy();
        expect(within(row).queryByRole('button', { name: 'Done' })).toBeNull();

        const doneButton = screen.getByRole('button', { name: 'Done' });
        expect(within(doneButton.parentElement as HTMLElement).queryByLabelText('Use primary colour')).toBeNull();
    });

    it('shows no "From your brand" row when there are no other brand colours', () => {
        renderLook(vi.fn(), { ...brand, colors: { primary: '#00A651' } });
        fireEvent.click(screen.getByLabelText('Edit primary colour'));
        expect(screen.queryByText('From your brand')).toBeNull();
    });
});

describe('live preview while a colour is being picked', () => {
    it('typing a valid hex updates the preview without closing or saving', () => {
        const onSave = renderLook();
        const cta = () => within(screen.getByTestId('brand-preview-cta'));
        expect(cta().getByText('Shop now').parentElement).toBeTruthy();
        expect(screen.getByTestId('brand-preview-cta').getAttribute('style')).toContain('rgb(0, 166, 81)'); // #00A651

        fireEvent.click(screen.getByLabelText('Edit primary colour'));
        const hexInput = screen.getByLabelText('primary hex value');
        fireEvent.change(hexInput, { target: { value: 'FF0000' } });

        expect(screen.getByTestId('brand-preview-cta').getAttribute('style')).toContain('rgb(255, 0, 0)');
        expect(onSave).not.toHaveBeenCalled();
    });
});
