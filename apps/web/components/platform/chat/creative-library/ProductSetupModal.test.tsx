/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductSetupModal } from './ProductSetupModal';
import type { ProductRecord } from './productsApi';

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
        expect(onSave).toHaveBeenCalledWith({ name: 'Mug', category: null, description: 'A mug', usps: ['Dishwasher safe'] });
    });

    it('calls onSave in edit mode without requiring the name field to change', () => {
        const onSave = vi.fn();
        render(<ProductSetupModal open onOpenChange={vi.fn()} product={product()} onSave={onSave} />);
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        expect(onSave).toHaveBeenCalledWith({ name: 'Campus Shoes', category: 'Apparel', description: 'Everyday sneaker', usps: ['Lightweight'] });
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
