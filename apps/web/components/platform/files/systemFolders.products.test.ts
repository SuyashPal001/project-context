import { describe, expect, it } from 'vitest';
import { isProductFileKey, isSystemFolder, isUpload, uploadsWithOrphanProductFiles, withProductsPill } from './systemFolders';

const file = (id: string, key: string) => ({ id, key });

describe('product files in Drive', () => {
    it('treats imported-products as a hidden system folder that is not an upload', () => {
        expect(isSystemFolder('imported-products')).toBe(true);
        expect(isUpload('imported-products/x.jpg')).toBe(false);
        expect(isProductFileKey('imported-products/x.jpg')).toBe(true);
        expect(isProductFileKey('creative-products/y.png')).toBe(true);
        expect(isProductFileKey('chat-attachments/z.png')).toBe(false);
    });

    it('adds product photos no product references to Uploads', () => {
        const files = [file('u1', 'chat-attachments/a.png'), file('p1', 'creative-products/b.png'), file('p2', 'imported-products/c.jpg'), file('g1', 'generated/d.png')];
        expect(uploadsWithOrphanProductFiles(files, new Set(['p1'])).map(f => f.id)).toEqual(['u1', 'p2']);
    });

    it('shows no product photos in Uploads while the referenced ids are still loading', () => {
        const files = [file('u1', 'chat-attachments/a.png'), file('p1', 'creative-products/b.png')];
        expect(uploadsWithOrphanProductFiles(files, null).map(f => f.id)).toEqual(['u1']);
    });

    it('always includes the Products pill, ordered by PILL_FOLDERS, even for a tenant with no creative-products files', () => {
        expect(withProductsPill([])).toEqual(['creative-products']);
        expect(withProductsPill(['generated'])).toEqual(['creative-products', 'generated']);
        expect(withProductsPill(['creative-avatars', 'generated'])).toEqual(['creative-avatars', 'creative-products', 'generated']);
        expect(withProductsPill(['creative-products'])).toEqual(['creative-products']);
    });
});
