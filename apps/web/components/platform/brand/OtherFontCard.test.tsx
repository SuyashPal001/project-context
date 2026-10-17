/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { deriveFontFamilyName, otherFontSelected, OtherFontCard } from './OtherFontCard';
import { EMPTY_BRAND, type BrandRecord } from './brandApi';
import { storeCreativeImage } from '../chat/creative-library/storeCreativeImage';
import { ApiError } from '@/lib/api';

vi.mock('../chat/creative-library/storeCreativeImage', () => ({ storeCreativeImage: vi.fn() }));

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

describe('deriveFontFamilyName', () => {
    it('strips the extension and a trailing weight word', () => {
        expect(deriveFontFamilyName('BrandSans-Bold.otf')).toBe('BrandSans');
        expect(deriveFontFamilyName('Acme_Regular.ttf')).toBe('Acme');
        expect(deriveFontFamilyName('Acme.ttf')).toBe('Acme');
    });

    it('leaves a name with no weight word alone', () => {
        expect(deriveFontFamilyName('House-Grotesk.otf')).toBe('House Grotesk');
    });
});

describe('otherFontSelected', () => {
    it('is true for an uploaded font even if the curated-looking name matches', () => {
        expect(otherFontSelected({ headlineFont: 'Poppins', font: { fileId: 'f1', url: null } })).toBe(true);
    });
    it('is true for a non-curated headline font with no upload', () => {
        expect(otherFontSelected({ headlineFont: 'Comic Sans MS', font: null })).toBe(true);
    });
    it('is false for a curated font with no upload', () => {
        expect(otherFontSelected({ headlineFont: 'Poppins', font: null })).toBe(false);
    });
    it('is false when nothing is set', () => {
        expect(otherFontSelected({ headlineFont: null, font: null })).toBe(false);
    });
});

function openCard(brand: BrandRecord = EMPTY_BRAND, onSave = vi.fn()) {
    render(<OtherFontCard brand={brand} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Other font/ }));
    return onSave;
}

describe('OtherFontCard', () => {
    it('shows the Google Fonts tab by default with a search box', () => {
        openCard();
        expect(screen.getByLabelText('Search Google Fonts')).toBeTruthy();
    });

    it('searches fonts case-insensitively and picks one', () => {
        const onSave = openCard();
        fireEvent.change(screen.getByLabelText('Search Google Fonts'), { target: { value: 'abeezee' } });
        fireEvent.click(screen.getByText(/ABeeZee/));
        expect(onSave).toHaveBeenCalledWith({ headlineFont: 'ABeeZee', fontFileId: null });
    });

    it('switches to Upload and keeps the file input disabled until the checkbox is ticked', () => {
        openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        expect((screen.getByLabelText('Upload font file') as HTMLInputElement).disabled).toBe(true);
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        expect((screen.getByLabelText('Upload font file') as HTMLInputElement).disabled).toBe(false);
    });

    it('uses the app button, not the browser file picker look, and enables it only after the tick', () => {
        openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        const btn = screen.getByRole('button', { name: 'Choose a .ttf or .otf file' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        expect(btn.disabled).toBe(false);
        expect((screen.getByLabelText('Upload font file') as HTMLInputElement).className).toContain('sr-only');
    });

    it('rejects a non-ttf/otf file before uploading', async () => {
        const onSave = openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        const file = new File(['x'], 'font.woff2', { type: 'font/woff2' });
        fireEvent.change(screen.getByLabelText('Upload font file'), { target: { files: [file] } });
        expect(await screen.findByText('Upload a .ttf or .otf font file')).toBeTruthy();
        expect(storeCreativeImage).not.toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('rejects a font file over 5 MB', async () => {
        openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'Big.ttf', { type: 'font/ttf' });
        fireEvent.change(screen.getByLabelText('Upload font file'), { target: { files: [big] } });
        expect(await screen.findByText('That font is larger than 5 MB.')).toBeTruthy();
        expect(storeCreativeImage).not.toHaveBeenCalled();
    });

    it('uploads a valid .otf and derives the family name from the filename', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValue({ fileId: 'f1', name: 'BrandSans-Bold.otf', type: 'font/otf', size: 10 });
        const onSave = openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        const file = new File(['x'], 'BrandSans-Bold.otf', { type: 'font/otf' });
        fireEvent.change(screen.getByLabelText('Upload font file'), { target: { files: [file] } });
        await waitFor(() => expect(onSave).toHaveBeenCalledWith({ fontFileId: 'f1', headlineFont: 'BrandSans' }));
    });

    it('shows a plain fallback message on an unexpected upload error', async () => {
        vi.mocked(storeCreativeImage).mockRejectedValue(new Error('boom'));
        openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        const file = new File(['x'], 'BrandSans.ttf', { type: 'font/ttf' });
        fireEvent.change(screen.getByLabelText('Upload font file'), { target: { files: [file] } });
        await waitFor(() => expect(screen.getByText("Couldn't add that font. Try again.")).toBeTruthy());
    });

    it('shows the API 400 message when the server rejects the upload', async () => {
        vi.mocked(storeCreativeImage).mockRejectedValue(new ApiError(400, { message: 'Upload a .ttf or .otf font file' }));
        openCard();
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        fireEvent.click(screen.getByLabelText('I have the right to use this font'));
        const file = new File(['x'], 'BrandSans.ttf', { type: 'font/ttf' });
        fireEvent.change(screen.getByLabelText('Upload font file'), { target: { files: [file] } });
        await waitFor(() => expect(screen.getByText('Upload a .ttf or .otf font file')).toBeTruthy());
    });

    it('shows the current uploaded font name on the Upload tab', () => {
        openCard({ ...EMPTY_BRAND, headlineFont: 'BrandSans', font: { fileId: 'f1', url: 'https://x/f.otf' }, fontName: 'BrandSans-Bold.otf' });
        fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
        expect(screen.getByText(/Current: BrandSans-Bold.otf/)).toBeTruthy();
    });
});
