/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveProducts } from './DriveProducts';
import * as productsApi from '@/components/platform/chat/creative-library/productsApi';

vi.mock('@/components/platform/chat/creative-library/productsApi', async (orig) => ({
    ...(await orig<typeof import('@/components/platform/chat/creative-library/productsApi')>()),
    listProducts: vi.fn(),
}));
vi.mock('@/components/platform/files/FileThumbnail', () => ({ FileThumbnail: () => <span /> }));
vi.mock('./components/AddToChatMenu', () => ({
    AddToChatMenu: ({ onPick, label }: { onPick: (id: string | null) => void; label?: string }) =>
        <button type="button" onClick={() => onPick(null)}>{label ?? 'Add to chat'}</button>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

const images = [
    { fileId: 'f1', name: 'Serum.png', type: 'image/png', size: 3 },
    { fileId: 'f2', name: 'Serum (2).png', type: 'image/png', size: 3 },
];
const product = { id: 'p1', name: 'Serum', category: null, description: null, price: null, sourceUrl: null, usps: [], namingStatus: 'done' as const, images, createdAt: '2026-09-27T00:00:00.000Z' };

function renderDrive(props: Partial<Parameters<typeof DriveProducts>[0]> = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
    const onAddToChat = vi.fn();
    const onDownload = vi.fn();
    render(<QueryClientProvider client={client}><DriveProducts conversations={[]} canAddToChat onAddToChat={onAddToChat} onDownload={onDownload} {...props} /></QueryClientProvider>);
    return { onAddToChat, onDownload, client };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [product] }); });

describe('DriveProducts', () => {
    it('lists products by name, not files', async () => {
        renderDrive();
        expect(await screen.findByText('Serum')).toBeTruthy();
        expect(screen.queryByText('Serum (2).png')).toBeNull();
    });

    it('opens a product to show its photos, adds them all to chat, downloads one, and goes back', async () => {
        const { onAddToChat, onDownload } = renderDrive();
        fireEvent.click(await screen.findByRole('button', { name: 'Open Serum' }));
        expect(screen.getByText('Serum (2).png')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Add photos to chat' }));
        expect(onAddToChat).toHaveBeenCalledWith(images, null);
        // Per-photo download only — no bulk "Download photos" button. A bulk
        // click-once-per-image button would rely on window.open firing more
        // than once per user gesture, which browsers block.
        expect(screen.queryByRole('button', { name: /Download photos/ })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Download Serum (2).png' }));
        expect(onDownload).toHaveBeenCalledWith('f2');
        fireEvent.click(screen.getByRole('button', { name: /Back to products/ }));
        expect(await screen.findByRole('button', { name: 'Open Serum' })).toBeTruthy();
    });

    it('keeps the product list mounted (search survives) while a product is open', async () => {
        renderDrive();
        const search = await screen.findByLabelText('Search products');
        fireEvent.change(search, { target: { value: 'ser' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Open Serum' }));
        fireEvent.click(screen.getByRole('button', { name: /Back to products/ }));
        expect((await screen.findByLabelText('Search products') as HTMLInputElement).value).toBe('ser');
    });

    // ['creative-products'] is a prefix match on the query cache — it also
    // matches FilesList's ['creative-products', '__image-file-ids'] query,
    // whose data is a plain string[], not { pages: [...] }. Opening a product
    // must not throw when that entry (or the older key it replaced) is present.
    it('opens a product without throwing when the cache also holds an unrelated creative-products entry', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        client.setQueryData(['creative-products', '__image-file-ids'], ['f1']);
        client.setQueryData(['creative-products', 'image-file-ids'], ['f1']);
        renderDrive({}, client);
        const openButton = await screen.findByRole('button', { name: 'Open Serum' });
        expect(() => fireEvent.click(openButton)).not.toThrow();
        expect(screen.getByText('Serum (2).png')).toBeTruthy();
    });

    it('shows a live rename in the opened header, not the snapshot taken when it was opened', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        renderDrive({}, client);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Serum' }));
        expect(screen.getByRole('heading', { name: 'Serum' })).toBeTruthy();

        const renamed = { ...product, name: 'Renamed Serum' };
        client.setQueryData(['creative-products', ''], { pages: [{ data: [renamed] }], pageParams: [0] });

        expect(await screen.findByRole('heading', { name: 'Renamed Serum' })).toBeTruthy();
    });
});
