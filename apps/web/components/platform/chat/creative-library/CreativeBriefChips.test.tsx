/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreativeBriefChips } from './CreativeBriefChips';
import { createEmptyCreativeBrief, updateCreativeBrief } from './creativeBriefModel';

vi.mock('@/components/platform/files/FileThumbnail', () => ({
    FileThumbnail: ({ alt }: { alt: string }) => <span data-testid="file-thumbnail">{alt}</span>,
}));

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

describe('CreativeBriefChips', () => {
    it('opens and removes the selected field through explicit controls', () => {
        const brief = updateCreativeBrief(createEmptyCreativeBrief(), {
            kind: 'voice', id: 'nandi', name: 'Nandi', language: 'hi', languageLabel: 'Hindi',
        });
        const onEdit = vi.fn();
        const onRemove = vi.fn();
        render(<CreativeBriefChips brief={brief} onEdit={onEdit} onRemove={onRemove} />);

        fireEvent.click(screen.getByRole('button', { name: /Voice Nandi · Hindi/ }));
        expect(onEdit).toHaveBeenCalledWith('voice');
        fireEvent.click(screen.getByRole('button', { name: 'Remove voice' }));
        expect(onRemove).toHaveBeenCalledWith('voice');
    });

    it('renders compact visual pills for all four creative selections', () => {
        const attachment = { fileId: 'file-1', name: 'product.jpg', type: 'image/jpeg', size: 100 };
        const brief = {
            template: { kind: 'template' as const, id: 'demo', title: 'Product Demo', category: 'Demonstration', image: '/creative/templates/product-demo.png' },
            avatar: { kind: 'avatar' as const, id: 'mira', name: 'Mira', role: 'Creator', tone: 'Casual', image: '/creative/avatars/everyday-creator.jpg', attachment: { ...attachment, fileId: 'avatar-1', name: 'mira.jpg' } },
            product: { kind: 'product-image' as const, id: 'file-1', name: 'product.jpg', attachment },
            voice: { kind: 'voice' as const, id: 'lauren', name: 'Lauren', language: 'en', languageLabel: 'English' },
        };

        render(<CreativeBriefChips brief={brief} onEdit={vi.fn()} onRemove={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Template Product Demo' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Avatar Mira' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Product product.jpg' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Voice Lauren · English' })).toBeTruthy();
        expect(screen.getByLabelText('Selected creative assets').querySelectorAll('img')).toHaveLength(3);
        expect(screen.getByTestId('file-thumbnail')).toBeTruthy();
    });

    it('uses the uploaded avatar file in its read-only hover preview', async () => {
        const brief = updateCreativeBrief(createEmptyCreativeBrief(), {
            kind: 'avatar',
            id: 'custom:avatar-file',
            name: 'my-avatar.jpg',
            role: 'Uploaded presenter',
            tone: 'Custom',
            attachment: { fileId: 'avatar-file', name: 'my-avatar.jpg', type: 'image/jpeg', size: 100 },
        });
        render(<CreativeBriefChips brief={brief} readOnly />);

        fireEvent.focus(screen.getByLabelText('Avatar my-avatar.jpg'));
        await waitFor(() => expect(screen.getAllByTestId('file-thumbnail').length).toBeGreaterThan(1));
    });

    it('shows the selected imported image on a product-url chip, else the link icon', () => {
        const base = { kind: 'product-url' as const, id: 'https://shop.example.com/p/1', name: 'Mug', url: 'https://shop.example.com/p/1' };
        const imported = { title: 'Mug', description: null, price: null, images: [], selectedImageId: 'file-1' };
        const withImage = updateCreativeBrief(createEmptyCreativeBrief(), { ...base, imported });
        const { unmount } = render(<CreativeBriefChips brief={withImage} readOnly />);
        expect(screen.getByTestId('file-thumbnail')).toBeTruthy();
        unmount();

        const withoutImage = updateCreativeBrief(createEmptyCreativeBrief(), { ...base, imported: { ...imported, selectedImageId: null } });
        render(<CreativeBriefChips brief={withoutImage} readOnly />);
        expect(screen.queryByTestId('file-thumbnail')).toBeNull();
    });

    it('shows the selected imported image in the hover preview; link-only keeps the stock image', async () => {
        const base = { kind: 'product-url' as const, id: 'https://shop.example.com/p/1', name: 'Mug', url: 'https://shop.example.com/p/1' };
        const imported = { title: 'Mug', description: null, price: null, images: [], selectedImageId: 'file-1' };
        const withImage = updateCreativeBrief(createEmptyCreativeBrief(), { ...base, imported });
        const { unmount } = render(<CreativeBriefChips brief={withImage} readOnly />);
        fireEvent.focus(screen.getByLabelText('Product Mug'));
        await waitFor(() => expect(screen.getAllByTestId('file-thumbnail').length).toBeGreaterThan(1));
        expect(document.querySelector('img[src*="add-link"]')).toBeNull();
        unmount();

        render(<CreativeBriefChips brief={updateCreativeBrief(createEmptyCreativeBrief(), base)} readOnly />);
        fireEvent.focus(screen.getByLabelText('Product Mug'));
        await waitFor(() => expect(document.querySelector('img[src*="add-link"]')).not.toBeNull());
        expect(screen.queryByTestId('file-thumbnail')).toBeNull();
    });
});
