/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ProductsPanel } from './ProductsPanel';
import * as productsApi from './productsApi';
import { storeCreativeImage } from './storeCreativeImage';
import type { ProductRecord } from './productsApi';

vi.mock('./storeCreativeImage', () => ({ storeCreativeImage: vi.fn() }));
vi.mock('./productsApi', async (orig) => ({
    ...(await orig<typeof import('./productsApi')>()),
    listProducts: vi.fn(), createProductFromFiles: vi.fn(), importProductFromUrl: vi.fn(),
    describeProduct: vi.fn(), renameProduct: vi.fn(), deleteProduct: vi.fn(),
}));
vi.mock('@/components/platform/files/FileThumbnail', () => ({ FileThumbnail: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix menus need these in jsdom. jsdom has no PointerEvent constructor at
// all (only MouseEvent), so Radix's pointerdown-based open/close handlers
// never fire under userEvent.click without this polyfill.
class MockPointerEvent extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, props: PointerEventInit = {}) {
        super(type, props);
        this.pointerType = props.pointerType ?? 'mouse';
        this.pointerId = props.pointerId ?? 1;
    }
}
beforeAll(() => {
    Object.assign(window, { PointerEvent: MockPointerEvent });
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, scrollIntoView: () => {} });
});

const image = (fileId: string) => ({ fileId, name: `${fileId}.png`, type: 'image/png', size: 3 });
const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
    id: 'p1', name: 'Niacinamide serum', description: 'A dropper bottle.', price: null, sourceUrl: null,
    namingStatus: 'done', images: [image('f1')], createdAt: '2026-09-27T00:00:00.000Z', ...over,
});

function renderPanel(onSelect = vi.fn(), selected: Parameters<typeof ProductsPanel>[0]['selected'] = null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return { onSelect, ...render(<QueryClientProvider client={client}><ProductsPanel selected={selected} onSelect={onSelect} /></QueryClientProvider>) };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [] });
});
afterEach(() => vi.useRealTimers());

describe('ProductsPanel', () => {
    it('shows one drop zone and the skip line when there are no products', async () => {
        renderPanel();
        expect(await screen.findByText('Paste a product link or drop photos')).toBeTruthy();
        expect(screen.getByText('You can skip this. Olmo will ask about your product in chat.')).toBeTruthy();
    });

    it('uploads dropped photos, creates a product, selects it, then selects the AI-named version', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValueOnce(image('f1')).mockResolvedValueOnce(image('f2'));
        vi.mocked(productsApi.createProductFromFiles).mockResolvedValue(record({ name: 'Untitled product', namingStatus: 'pending', images: [image('f1'), image('f2')] }));
        vi.mocked(productsApi.describeProduct).mockResolvedValue(record({ images: [image('f1'), image('f2')] }));
        const onSelect = vi.fn();
        const { rerender } = renderPanel(onSelect);
        const files = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })];

        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files } });

        await waitFor(() => expect(productsApi.createProductFromFiles).toHaveBeenCalledWith(['f1', 'f2']));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product', id: 'p1', namingStatus: 'pending' })));
        // The parent passes the selection back down, as ChatComposer does.
        rerender(<QueryClientProvider client={new QueryClient()}><ProductsPanel selected={{ ...productsApi.productSelection(record({ namingStatus: 'pending' })) }} onSelect={onSelect} /></QueryClientProvider>);
        await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'product', name: 'Niacinamide serum', namingStatus: 'done' })));
    });

    it('does not override a different product the user picked while naming ran', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValue(image('f1'));
        vi.mocked(productsApi.createProductFromFiles).mockResolvedValue(record({ namingStatus: 'pending' }));
        let finishNaming: (r: ProductRecord) => void = () => {};
        vi.mocked(productsApi.describeProduct).mockReturnValue(new Promise(resolve => { finishNaming = resolve; }));
        const onSelect = vi.fn();
        const { rerender } = renderPanel(onSelect);

        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } });
        await waitFor(() => expect(productsApi.describeProduct).toHaveBeenCalled());
        const other = productsApi.productSelection(record({ id: 'p2', name: 'Other' }));
        rerender(<QueryClientProvider client={new QueryClient()}><ProductsPanel selected={other} onSelect={onSelect} /></QueryClientProvider>);
        const callsBefore = onSelect.mock.calls.length;
        await act(async () => finishNaming(record()));

        expect(onSelect.mock.calls.length).toBe(callsBefore);
    });

    it('rejects more than 6 photos without uploading', async () => {
        renderPanel();
        const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }));
        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files } });
        expect(toast.error).toHaveBeenCalledWith('Add up to 6 photos of one product at a time.');
        expect(storeCreativeImage).not.toHaveBeenCalled();
    });

    it('imports a pasted link and selects the saved product', async () => {
        vi.mocked(productsApi.importProductFromUrl).mockResolvedValue(record({ sourceUrl: 'https://shop.example.com/p/1' }));
        const onSelect = vi.fn();
        renderPanel(onSelect);
        const input = await screen.findByLabelText('Product link');

        fireEvent.paste(input, { clipboardData: { getData: () => 'https://shop.example.com/p/1' } });

        await waitFor(() => expect(productsApi.importProductFromUrl).toHaveBeenCalledWith('https://shop.example.com/p/1'));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product', sourceUrl: 'https://shop.example.com/p/1' })));
        expect(productsApi.describeProduct).not.toHaveBeenCalled();
    });

    it('shows the no-dead-end message when a link cannot be read, and saves nothing', async () => {
        vi.mocked(productsApi.importProductFromUrl).mockRejectedValue(new Error('422'));
        const onSelect = vi.fn();
        renderPanel(onSelect);
        const input = await screen.findByLabelText('Product link');
        fireEvent.change(input, { target: { value: 'https://blocked.example.com/p' } });
        fireEvent.submit(input.closest('form')!);

        expect(await screen.findByRole('alert')).toHaveProperty('textContent', "Couldn't read this page. Drop a product photo instead.");
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('lists products by name, never filename, and shows Naming… while pending', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record(), record({ id: 'p2', name: 'Untitled product', namingStatus: 'pending' })] });
        renderPanel();
        expect(await screen.findByText('Niacinamide serum')).toBeTruthy();
        expect(screen.getByText('Naming…')).toBeTruthy();
        expect(screen.queryByText('f1.png')).toBeNull();
    });

    it('selects a product when its card is clicked', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        const onSelect = vi.fn();
        renderPanel(onSelect);
        fireEvent.click(await screen.findByRole('button', { name: 'Use Niacinamide serum' }));
        expect(onSelect).toHaveBeenCalledWith(productsApi.productSelection(record()));
    });

    it('renames a product inline from the menu', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        vi.mocked(productsApi.renameProduct).mockResolvedValue(record({ name: 'My serum' }));
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByRole('button', { name: 'More options for Niacinamide serum' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
        const field = await screen.findByLabelText('Product name');
        await user.clear(field);
        await user.type(field, 'My serum{Enter}');
        await waitFor(() => expect(productsApi.renameProduct).toHaveBeenCalledWith('p1', 'My serum'));
    });

    it('deletes after the undo window, and Undo cancels it', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByRole('button', { name: 'More options for Niacinamide serum' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

        expect(screen.queryByText('Niacinamide serum')).toBeNull();
        const undo = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
        act(() => undo.action.onClick());
        expect(await screen.findByText('Niacinamide serum')).toBeTruthy();
        await new Promise(resolve => setTimeout(resolve, 5100));
        expect(productsApi.deleteProduct).not.toHaveBeenCalled();
    }, 10_000);
});
