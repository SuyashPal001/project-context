/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { api } from '@/lib/api';
import { FileThumbnail } from './FileThumbnail';

afterEach(() => {
    vi.restoreAllMocks();
});

function renderWithClient(children: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe('FileThumbnail', () => {
    it('resolves the tenant files download URL directly by default', async () => {
        vi.spyOn(api, 'get').mockResolvedValue({ data: { downloadUrl: 'https://files.example/a.png' } });
        renderWithClient(<FileThumbnail fileId="file-1" alt="a" />);
        await waitFor(() => expect(screen.getByAltText('a').getAttribute('src')).toBe('https://files.example/a.png'));
    });

    it('does not fall back to the library-assets route by default when the files lookup 404s', async () => {
        const err = new Error('Not Found') as Error & { status?: number };
        err.status = 404;
        vi.spyOn(api, 'get').mockRejectedValue(err);
        renderWithClient(<FileThumbnail fileId="asset-1" alt="b" />);
        await waitFor(() => expect(screen.queryByAltText('b')).toBeNull());
    });

    it('falls back to /creative-library-assets/:id/presigned-url on a 404 when fallbackToLibraryAsset is set', async () => {
        // Regression: a clarification option's imageFileId can point at a
        // creative_library_assets id (platform preset), not a tenant files
        // row — /files/:id/download 404s there, and the tile must retry
        // against the library route instead of showing a broken thumbnail.
        vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
            if (path.includes('/files/')) {
                const err = new Error('Not Found') as Error & { status?: number };
                err.status = 404;
                throw err;
            }
            if (path.includes('/creative-library-assets/')) {
                return { presignedUrl: 'https://library.example/preset.png' };
            }
            throw new Error(`unexpected path ${path}`);
        });
        renderWithClient(<FileThumbnail fileId="asset-1" alt="c" fallbackToLibraryAsset />);
        await waitFor(() => expect(screen.getByAltText('c').getAttribute('src')).toBe('https://library.example/preset.png'));
    });

    it('does not retry the library route on a non-404 error even with fallbackToLibraryAsset set', async () => {
        const err = new Error('Forbidden') as Error & { status?: number };
        err.status = 403;
        const getSpy = vi.spyOn(api, 'get').mockRejectedValue(err);
        renderWithClient(<FileThumbnail fileId="file-1" alt="d" fallbackToLibraryAsset />);
        await waitFor(() => expect(screen.queryByAltText('d')).toBeNull());
        expect(getSpy.mock.calls.every(([path]) => (path as string).includes('/files/'))).toBe(true);
    });
});
