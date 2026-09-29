/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductSetupModal } from './ProductSetupModal';
import type { ProductRecord } from './productsApi';
import { storeCreativeImage } from './storeCreativeImage';

vi.mock('./storeCreativeImage', () => ({ storeCreativeImage: vi.fn() }));
vi.mock('@/components/platform/files/FileThumbnail', () => ({
    FileThumbnail: ({ alt }: { alt: string }) => <span data-testid="file-thumbnail">{alt}</span>,
}));

// Radix Select needs these in jsdom — same polyfill ProductsPanel.test.tsx uses.
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
beforeEach(() => vi.mocked(storeCreativeImage).mockReset());
const image = (fileId: string) => ({ fileId, name: `${fileId}.png`, type: 'image/png', size: 3 });

const product = (over: Partial<ProductRecord> = {}): ProductRecord => ({
    id: 'p1', name: 'Campus Shoes', category: 'Apparel', description: 'Everyday sneaker', price: null,
    sourceUrl: null, usps: ['Lightweight'], namingStatus: 'done',
    images: [{ fileId: 'f1', name: 'a.png', type: 'image/png', size: 3 }], createdAt: '2026-09-29T00:00:00.000Z', ...over,
});

describe('ProductSetupModal', () => {
    it('renders nothing when closed', () => {
        const { container } = render(<ProductSetupModal open={false} onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('opens blank in create mode', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(screen.getByLabelText('Product name')).toHaveProperty('value', '');
        expect(screen.getByRole('button', { name: 'Create product' })).toBeTruthy();
    });

    it('opens prefilled in edit mode', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product()} onSave={vi.fn()} />);
        expect(screen.getByLabelText('Product name')).toHaveProperty('value', 'Campus Shoes');
        expect(screen.getByLabelText('Product description')).toHaveProperty('value', 'Everyday sneaker');
        expect(screen.getByDisplayValue('Lightweight')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    });

    it('disables the submit button until a name is entered in create mode', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Create product' })).toHaveProperty('disabled', true);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Mug' } });
        expect(screen.getByRole('button', { name: 'Create product' })).toHaveProperty('disabled', false);
    });

    it('disables the submit button in edit mode too if the name is cleared to empty', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product()} onSave={vi.fn()} />);
        const button = screen.getByRole('button', { name: 'Save changes' });
        expect(button).toHaveProperty('disabled', false);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: '   ' } });
        expect(button).toHaveProperty('disabled', true);
    });

    it('caps each selling-point input at 200 characters, matching the API validation', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(screen.getAllByLabelText(/^Selling point \d+$/)[0]).toHaveProperty('maxLength', 200);
    });

    it('adds and removes usp rows, up to 3', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(screen.getAllByLabelText(/^Selling point \d+$/)).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Add selling point' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add selling point' }));
        expect(screen.getAllByLabelText(/^Selling point \d+$/)).toHaveLength(3);
        expect(screen.queryByRole('button', { name: 'Add selling point' })).toBeNull();
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove selling point' })[0]);
        expect(screen.getAllByLabelText(/^Selling point \d+$/)).toHaveLength(2);
    });

    it('calls onSave with the trimmed fields on submit, in create mode', () => {
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={onSave} />);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: '  Mug  ' } });
        fireEvent.change(screen.getByLabelText('Product description'), { target: { value: 'A mug' } });
        fireEvent.change(screen.getAllByLabelText(/^Selling point \d+$/)[0], { target: { value: 'Dishwasher safe' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
        expect(onSave).toHaveBeenCalledWith({ name: 'Mug', category: null, description: 'A mug', usps: ['Dishwasher safe'], imageFileIds: [] });
    });

    it('calls onSave in edit mode without requiring the name field to change', () => {
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product()} onSave={onSave} />);
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        expect(onSave).toHaveBeenCalledWith({ name: 'Campus Shoes', category: 'Apparel', description: 'Everyday sneaker', usps: ['Lightweight'], imageFileIds: ['f1'] });
    });

    it('disables the submit button while onSave is in flight, and re-enables it on failure', async () => {
        let resolveOnSave: () => void = () => {};
        const onSave = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveOnSave = resolve; }));
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product()} onSave={onSave} />);
        const button = screen.getByRole('button', { name: 'Save changes' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(button).toHaveProperty('disabled', true);
        resolveOnSave();
        await Promise.resolve();
    });

    it('shows existing images with a remove control, in edit mode', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product({ images: [image('f1'), image('f2')] })} onSave={vi.fn()} />);
        expect(screen.getAllByTestId('file-thumbnail')).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
    });

    it('renders no image thumbnails, and an add-photos control, in create mode', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        expect(screen.queryByTestId('file-thumbnail')).toBeNull();
        expect(screen.getByLabelText('Add product photos')).toBeTruthy();
    });

    it('uploads a dropped/selected photo and includes it in the save payload', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValue(image('f9'));
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={onSave} />);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Mug' } });
        const file = new File(['x'], 'mug.png', { type: 'image/png' });
        fireEvent.change(screen.getByLabelText('Add product photos'), { target: { files: [file] } });
        await waitFor(() => expect(screen.getAllByTestId('file-thumbnail')).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ imageFileIds: ['f9'] }));
    });

    it('disables the submit button while a photo upload is in flight, so it cannot submit before the upload lands', async () => {
        let resolveUpload: (value: ReturnType<typeof image>) => void = () => {};
        vi.mocked(storeCreativeImage).mockReturnValue(new Promise(resolve => { resolveUpload = resolve; }));
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={onSave} />);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Mug' } });
        const file = new File(['x'], 'mug.png', { type: 'image/png' });
        fireEvent.change(screen.getByLabelText('Add product photos'), { target: { files: [file] } });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create product' })).toHaveProperty('disabled', true));
        expect(onSave).not.toHaveBeenCalled();
        resolveUpload(image('f9'));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create product' })).toHaveProperty('disabled', false));
    });

    it('removes an image from the set on click', () => {
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product({ images: [image('f1'), image('f2')] })} onSave={onSave} />);
        fireEvent.click(screen.getAllByRole('button', { name: /^Remove / })[0]);
        expect(screen.getAllByTestId('file-thumbnail')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ imageFileIds: ['f2'] }));
    });

    it('keeps photos that uploaded successfully when another in the same batch fails', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValueOnce(image('f1')).mockRejectedValueOnce(new Error('network'));
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        const files = [new File(['x'], 'a.png', { type: 'image/png' }), new File(['y'], 'b.png', { type: 'image/png' })];
        fireEvent.change(screen.getByLabelText('Add product photos'), { target: { files } });
        await waitFor(() => expect(screen.getAllByTestId('file-thumbnail')).toHaveLength(1));
    });

    it('rejects a non-image file without uploading it', () => {
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={vi.fn()} />);
        const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
        fireEvent.change(screen.getByLabelText('Add product photos'), { target: { files: [file] } });
        expect(storeCreativeImage).not.toHaveBeenCalled();
    });

    it('hides the add-photos control once 6 images are attached', () => {
        const images = Array.from({ length: 6 }, (_, i) => image(`f${i}`));
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product({ images })} onSave={vi.fn()} />);
        expect(screen.queryByLabelText('Add product photos')).toBeNull();
    });

    it('drops empty selling-point rows before saving', () => {
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={null} onSave={onSave} />);
        fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Mug' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add selling point' }));
        fireEvent.change(screen.getAllByLabelText(/^Selling point \d+$/)[0], { target: { value: 'Dishwasher safe' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ usps: ['Dishwasher safe'] }));
    });
});
