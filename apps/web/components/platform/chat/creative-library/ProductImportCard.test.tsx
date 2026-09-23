/** @vitest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProductImportCard } from './ProductImportCard';
import type { ProductUrlSelection } from './creativeBriefModel';

vi.mock('@/components/platform/files/FileThumbnail', () => ({
    FileThumbnail: ({ alt }: { alt: string }) => <span data-testid="file-thumbnail">{alt}</span>,
}));

const baseSelection: ProductUrlSelection = {
    kind: 'product-url',
    id: 'https://shop.example.com/p/1',
    name: 'Ceramic Mug',
    url: 'https://shop.example.com/p/1',
    imported: {
        title: 'Ceramic Mug',
        description: 'A sturdy 12oz mug.',
        price: '19.00 USD',
        images: [
            { fileId: 'file-1', name: 'a.jpg', type: 'image/jpeg', size: 100 },
            { fileId: 'file-2', name: 'b.jpg', type: 'image/jpeg', size: 100 },
        ],
        selectedImageId: 'file-1',
    },
};

describe('ProductImportCard', () => {
    it('renders the imported title, description, and price as editable fields', () => {
        render(<ProductImportCard selection={baseSelection} onChange={vi.fn()} />);
        expect(screen.getByDisplayValue('Ceramic Mug')).toBeTruthy();
        expect(screen.getByDisplayValue('A sturdy 12oz mug.')).toBeTruthy();
        expect(screen.getByDisplayValue('19.00 USD')).toBeTruthy();
    });

    it('calls onChange with an edited title', () => {
        const onChange = vi.fn();
        render(<ProductImportCard selection={baseSelection} onChange={onChange} />);
        fireEvent.change(screen.getByDisplayValue('Ceramic Mug'), { target: { value: 'Large Ceramic Mug' } });
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            imported: expect.objectContaining({ title: 'Large Ceramic Mug' }),
        }));
    });

    it('renders every candidate image as a pickable option', () => {
        render(<ProductImportCard selection={baseSelection} onChange={vi.fn()} />);
        expect(screen.getAllByRole('button', { name: /use this image/i })).toHaveLength(2);
    });

    it('calls onChange with the newly picked selectedImageId', () => {
        const onChange = vi.fn();
        render(<ProductImportCard selection={baseSelection} onChange={onChange} />);
        fireEvent.click(screen.getAllByRole('button', { name: /use this image/i })[1]);
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            imported: expect.objectContaining({ selectedImageId: 'file-2' }),
        }));
    });

    it('renders nothing image-related when imported.images is empty', () => {
        render(<ProductImportCard selection={{ ...baseSelection, imported: { ...baseSelection.imported!, images: [] } }} onChange={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /use this image/i })).toBeNull();
    });

    it('renders nothing when the selection has no imported data', () => {
        const { container } = render(<ProductImportCard selection={{ kind: 'product-url', id: 'x', name: 'x', url: 'https://x.example.com' }} onChange={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });
});
