/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreativeLibrary } from './CreativeLibrary';
import { fetchCreativeVoice } from './creativeVoiceFetch';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { createEmptyCreativeBrief, type CreativeBrief } from './creative-library/creativeBriefModel';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('./creativeVoiceFetch', () => ({ fetchCreativeVoice: vi.fn() }));
vi.mock('@/components/platform/files/FileThumbnail', () => ({ FileThumbnail: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderLibrary(tab: 'templates' | 'avatars' | 'products' | 'audio', onSelect = vi.fn(), brief: CreativeBrief = createEmptyCreativeBrief()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return { onSelect, ...render(<QueryClientProvider client={client}><CreativeLibrary tab={tab} brief={brief} onSelect={onSelect} /></QueryClientProvider>) };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('creative library', () => {
    it('selects a typed template without inventing customer claims', () => {
        const { onSelect } = renderLibrary('templates');
        fireEvent.click(screen.getByRole('button', { name: /Testimonial/ }));
        expect(onSelect).toHaveBeenCalledWith({ kind: 'template', id: 'testimonial', title: 'Testimonial', category: 'Social proof', image: '/creative/templates/testimonial.png' });
    });

    it('attaches a selected presenter preset directly, with no upload round-trip', async () => {
        const { onSelect } = renderLibrary('avatars');

        expect(screen.getAllByRole('button', { name: /avatar$/ })).toHaveLength(6);
        fireEvent.click(screen.getByRole('button', { name: 'Use Arjun avatar' }));

        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'avatar', id: 'tech-presenter', name: 'Arjun',
            attachment: { fileId: '8b6e9254-cc47-492c-bdc7-557ac6302e01', name: 'Arjun', type: 'image/jpeg', size: 0 },
        })));
        expect(api.post).not.toHaveBeenCalled();
    });

    it('allows a presenter image upload and attaches it to the brief', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { fileId: 'avatar-2', uploadUrl: 'https://storage.example.com/custom' } });
        vi.mocked(api.post).mockResolvedValueOnce({ success: true });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
        const { onSelect } = renderLibrary('avatars');
        fireEvent.change(screen.getByLabelText('Upload presenter image'), { target: { files: [new File(['custom'], 'my-presenter.png', { type: 'image/png' })] } });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'avatar', name: 'my-presenter.png', role: 'Uploaded presenter',
            attachment: { fileId: 'avatar-2', name: 'my-presenter.png', type: 'image/png', size: 6 },
        })));
    });

    it('imports product data server-side and attaches it to the brief', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: {
            title: 'Ceramic Mug', description: 'A sturdy mug.', price: '19.00 USD',
            images: [{ fileId: 'file-1', name: 'mug.jpg', type: 'image/jpeg', size: 1024 }],
        } });
        const { onSelect } = renderLibrary('products');
        fireEvent.change(screen.getByRole('textbox', { name: 'Product page link' }), { target: { value: 'https://example.com/products/cup' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add link' }));

        expect(api.post).toHaveBeenCalledWith('/api/v1/products/import', { url: 'https://example.com/products/cup' });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'product-url', url: 'https://example.com/products/cup', name: 'Ceramic Mug',
            imported: expect.objectContaining({ title: 'Ceramic Mug', selectedImageId: 'file-1' }),
        })));
    });

    it('falls back to a link-only selection and a toast when import fails', async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new Error('network'));
        const { onSelect } = renderLibrary('products');
        fireEvent.change(screen.getByRole('textbox', { name: 'Product page link' }), { target: { value: 'https://example.com/products/cup' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add link' }));

        await waitFor(() => expect(onSelect).toHaveBeenCalledWith({
            kind: 'product-url', id: 'https://example.com/products/cup', name: 'example.com', url: 'https://example.com/products/cup',
        }));
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('added the link only'));
    });

    it('skips a second import when re-submitting the same already-imported URL', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { title: 'Ceramic Mug', description: null, price: null, images: [] } });
        const onSelect = vi.fn();
        const brief = createEmptyCreativeBrief();
        const { rerender } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CreativeLibrary tab="products" brief={brief} onSelect={onSelect} /></QueryClientProvider>);
        fireEvent.change(screen.getByRole('textbox', { name: 'Product page link' }), { target: { value: 'https://example.com/products/cup' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));

        const importedSelection = onSelect.mock.calls[0][0];
        const briefWithSelection = { ...brief, product: importedSelection };
        rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CreativeLibrary tab="products" brief={briefWithSelection} onSelect={onSelect} /></QueryClientProvider>);
        fireEvent.change(screen.getByRole('textbox', { name: 'Product page link' }), { target: { value: 'https://example.com/products/cup' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add link' }));

        expect(api.post).toHaveBeenCalledTimes(1); // not called again for the identical, already-imported URL
    });

    it('attaches an existing uploaded product image when selected', async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [{ id: 'file-1', key: 'creative-products/one-cup.png', filename: 'cup.png', contentType: 'image/png', size: 123 }] });
        const { onSelect } = renderLibrary('products');
        await screen.findAllByText('cup.png');
        fireEvent.click(screen.getByRole('button', { name: /cup.png/ }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ kind: 'product-image', id: 'file-1', name: 'cup.png', attachment: { fileId: 'file-1', name: 'cup.png', type: 'image/png', size: 123 } }));
    });

    it('stores an uploaded product image through the existing file service', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { fileId: 'file-2', uploadUrl: 'https://storage.example.com/signed' } });
        vi.mocked(api.post).mockResolvedValueOnce({ success: true, fileId: 'file-2' });
        const upload = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', upload);
        const { onSelect } = renderLibrary('products');
        fireEvent.change(screen.getByLabelText('Upload product image'), { target: { files: [new File(['img'], 'bottle.png', { type: 'image/png' })] } });
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/files/upload', expect.objectContaining({
            filename: 'bottle.png', contentType: 'image/png', size: 3, key: expect.stringMatching(/^creative-products\//),
        })));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/files/file-2/confirm', { size: 3 }));
        expect(upload).toHaveBeenCalledWith('https://storage.example.com/signed', expect.objectContaining({ method: 'PUT' }));
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product-image', id: 'file-2', name: 'bottle.png' }));
    });

    it('does not select a product in a later draft when its upload finishes after leaving Products', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { fileId: 'file-delayed', uploadUrl: 'https://storage.example.com/delayed-product' } });
        vi.mocked(api.post).mockResolvedValueOnce({ success: true });
        let finishUpload!: (result: { ok: boolean }) => void;
        const uploadPending = new Promise<{ ok: boolean }>(resolve => { finishUpload = resolve; });
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(uploadPending));
        const { onSelect, unmount } = renderLibrary('products');

        fireEvent.change(screen.getByLabelText('Upload product image'), { target: { files: [new File(['img'], 'delayed.png', { type: 'image/png' })] } });
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/files/upload', expect.anything()));
        unmount();
        finishUpload({ ok: true });

        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/files/file-delayed/confirm', { size: 3 }));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('uses the selected language for a multilingual voice brief', async () => {
        vi.mocked(fetchCreativeVoice).mockResolvedValue({
            ok: true,
            json: async () => ({ voices: [{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }] }),
        } as Response);
        const { onSelect } = renderLibrary('audio');
        fireEvent.change(screen.getByRole('combobox', { name: 'Voice language' }), { target: { value: 'hi' } });
        await screen.findByText('Cathy · Coworker');
        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        expect(onSelect).toHaveBeenCalledWith({ kind: 'voice', id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'hi', languageLabel: 'Hindi' });
        expect(screen.getAllByText('Hindi').length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Preview Hindi sample of Cathy' }));
        await waitFor(() => expect(fetchCreativeVoice).toHaveBeenCalledWith('/api/creative/voices/preview?id=cathy-id&language=hi'));
    });
});
