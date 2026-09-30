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

function renderLibrary(tab: 'templates' | 'avatars' | 'products' | 'audio', onSelect = vi.fn(), brief: CreativeBrief = createEmptyCreativeBrief(), onCreateAvatar?: () => void, createAvatarDisabled?: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return { onSelect, ...render(<QueryClientProvider client={client}><CreativeLibrary tab={tab} brief={brief} onSelect={onSelect} onCreateAvatar={onCreateAvatar} createAvatarDisabled={createAvatarDisabled} /></QueryClientProvider>) };
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

        expect(screen.getAllByRole('button', { name: /avatar$/ })).toHaveLength(80);
        fireEvent.click(screen.getByRole('button', { name: 'Use Arjun avatar' }));

        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'avatar', id: 'tech-presenter', name: 'Arjun',
            attachment: { fileId: '8b6e9254-cc47-492c-bdc7-557ac6302e01', name: 'Arjun', type: 'image/jpeg', size: 0 },
        })));
        expect(api.post).not.toHaveBeenCalled();
    });

    it('filters the library by UGC, Animation and TVC, and shows own avatars only under their own category', async () => {
        const own = (over: object) => ({ id: 'asset-1', fileId: 'file-1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', namingStatus: 'done', type: 'image/jpeg', size: 10, createdAt: '2026-09-29T00:00:00.000Z', ...over });
        vi.mocked(api.get).mockImplementation(async (url: string) => url === '/api/v1/creative-library-assets/avatars'
            ? { data: [own({ category: 'Animation', name: 'Bolt' }), own({ id: 'asset-2', fileId: 'file-2', name: 'Upload', category: null })] }
            : { data: [] });
        renderLibrary('avatars');
        expect(await screen.findByRole('button', { name: 'Use Bolt avatar' })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Animation' }));
        expect(screen.getByRole('button', { name: 'Use Lumo avatar' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Use Bolt avatar' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Use Arjun avatar' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Use Upload avatar' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'TVC' }));
        expect(screen.getAllByRole('button', { name: /avatar$/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Use Aroha avatar']);

        fireEvent.click(screen.getByRole('button', { name: 'UGC' }));
        expect(screen.getByRole('button', { name: 'Use Arjun avatar' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Use Lumo avatar' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'All' }));
        expect(screen.getByRole('button', { name: 'Use Upload avatar' })).toBeTruthy();
    });

    it('shows "Create with AI" when onCreateAvatar is passed, and calls it on click', () => {
        const onCreateAvatar = vi.fn();
        renderLibrary('avatars', vi.fn(), createEmptyCreativeBrief(), onCreateAvatar);
        const button = screen.getByRole('button', { name: 'Create with AI' });
        fireEvent.click(button);
        expect(onCreateAvatar).toHaveBeenCalledTimes(1);
    });

    it('has no "Create with AI" button when onCreateAvatar is absent', () => {
        renderLibrary('avatars');
        expect(screen.queryByRole('button', { name: 'Create with AI' })).toBeNull();
    });

    // Finding #2: "Create with AI" must not be clickable while the chat page
    // is mid-send or the conversation is inactive — double-creation risk.
    it('disables "Create with AI" when createAvatarDisabled is true', () => {
        renderLibrary('avatars', vi.fn(), createEmptyCreativeBrief(), vi.fn(), true);
        expect((screen.getByRole('button', { name: 'Create with AI' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('leaves "Create with AI" enabled when createAvatarDisabled is false or omitted', () => {
        renderLibrary('avatars', vi.fn(), createEmptyCreativeBrief(), vi.fn(), false);
        expect((screen.getByRole('button', { name: 'Create with AI' }) as HTMLButtonElement).disabled).toBe(false);
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

    it('names an uploaded presenter and attaches it under that name', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { fileId: 'avatar-3', uploadUrl: 'https://storage.example.com/custom' } });
        vi.mocked(api.post).mockResolvedValueOnce({ success: true });
        vi.mocked(api.post).mockResolvedValueOnce({ data: {
            id: 'asset-3', fileId: 'avatar-3', name: 'Riya', role: 'Fitness creator', tone: 'Energetic',
            namingStatus: 'done', type: 'image/png', size: 6, createdAt: '2026-09-29T00:00:00.000Z',
        } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
        const { onSelect } = renderLibrary('avatars');
        fireEvent.change(screen.getByLabelText('Upload presenter image'), { target: { files: [new File(['custom'], 'IMG_4432.png', { type: 'image/png' })] } });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith({
            kind: 'avatar', id: 'custom:avatar-3', name: 'Riya', role: 'Fitness creator', tone: 'Energetic',
            attachment: { fileId: 'avatar-3', name: 'Riya', type: 'image/png', size: 6 },
        }));
        expect(api.post).toHaveBeenLastCalledWith('/api/v1/creative-library-assets/avatars', { fileId: 'avatar-3' });
    });

    it('lists the tenant\'s own avatars above the library and names pending ones', async () => {
        const own = (over: object) => ({ id: 'asset-1', fileId: 'file-1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', namingStatus: 'done', type: 'image/jpeg', size: 10, createdAt: '2026-09-29T00:00:00.000Z', ...over });
        vi.mocked(api.get).mockImplementation(async (url: string) => url === '/api/v1/creative-library-assets/avatars'
            ? { data: [own({}), own({ id: 'asset-2', fileId: 'file-2', name: 'IMG_1', role: null, tone: null, namingStatus: 'pending' })] }
            : { data: [] });
        vi.mocked(api.post).mockResolvedValue({ data: own({ id: 'asset-2', fileId: 'file-2', name: 'Kabir' }) });
        const { onSelect } = renderLibrary('avatars');

        expect(await screen.findByText('Yours')).toBeTruthy();
        expect(screen.getByText('Naming…')).toBeTruthy();
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/creative-library-assets/avatars/asset-2/describe'));
        fireEvent.click(screen.getByRole('button', { name: 'Use Riya avatar' }));
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'avatar', id: 'custom:file-1', name: 'Riya', role: 'Fitness creator',
            attachment: { fileId: 'file-1', name: 'Riya', type: 'image/jpeg', size: 10 },
        }));
    });

    it('uses the selected language for a multilingual voice brief', async () => {
        vi.mocked(fetchCreativeVoice).mockResolvedValue({
            ok: true,
            json: async () => ({ voices: [{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }] }),
        } as Response);
        const { onSelect } = renderLibrary('audio');
        fireEvent.change(screen.getByRole('combobox', { name: 'Voice language' }), { target: { value: 'hi' } });
        await screen.findByText('Coworker');
        fireEvent.click(screen.getByRole('button', { name: 'Use Cathy voice' }));
        expect(onSelect).toHaveBeenCalledWith({ kind: 'voice', id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'hi', languageLabel: 'Hindi' });
        expect(screen.getAllByText('Hindi').length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Preview Hindi sample of Cathy' }));
        await waitFor(() => expect(fetchCreativeVoice).toHaveBeenCalledWith('/api/creative/voices/preview?id=cathy-id&language=hi', expect.objectContaining({ signal: expect.any(AbortSignal) })));
    });
});
