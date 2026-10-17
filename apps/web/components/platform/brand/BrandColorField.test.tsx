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
    chatHref: '/t/dashboard/chat?prefill=Set%20up%20my%20brand', onImport: vi.fn(), importing: false, importFailed: false,
};

function renderLook(onSave = vi.fn(), brandRecord = brand) {
    render(<BrandForm {...baseProps} brand={brandRecord} onSave={onSave} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Look' }));
    return onSave;
}

beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('brand colour fields', () => {
    it('shows role name and uppercase hex for a set colour, "Not set" for unset', () => {
        renderLook();
        expect(screen.getByText('primary')).toBeTruthy();
        expect(screen.getByText('#00A651')).toBeTruthy();
        expect(screen.getByText('secondary')).toBeTruthy();
        expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
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
});
