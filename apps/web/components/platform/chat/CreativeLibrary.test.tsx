/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreativeLibrary } from './CreativeLibrary';
import { fetchCreativeVoice } from './creativeVoiceFetch';
import { api } from '@/lib/api';
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

    it('uses the selected language for a multilingual voice brief', async () => {
        vi.mocked(fetchCreativeVoice).mockResolvedValue({
            ok: true,
            json: async () => ({ voices: [{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }] }),
        } as Response);
        const { onSelect } = renderLibrary('audio');
        fireEvent.change(screen.getByRole('combobox', { name: 'Voice language' }), { target: { value: 'hi' } });
        await screen.findByText('Coworker');
        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        expect(onSelect).toHaveBeenCalledWith({ kind: 'voice', id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'hi', languageLabel: 'Hindi' });
        expect(screen.getAllByText('Hindi').length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Preview Hindi sample of Cathy' }));
        await waitFor(() => expect(fetchCreativeVoice).toHaveBeenCalledWith('/api/creative/voices/preview?id=cathy-id&language=hi'));
    });
});
