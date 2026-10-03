import { describe, expect, it, vi } from 'vitest';
import { fetchAllFiles, FILES_PAGE_SIZE } from './fetchAllFiles';

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `f${from + i}` }));

describe('fetchAllFiles', () => {
    it('walks every page while the API says there is more', async () => {
        const get = vi.fn()
            .mockResolvedValueOnce({ data: rows(FILES_PAGE_SIZE), hasMore: true })
            .mockResolvedValueOnce({ data: rows(3, FILES_PAGE_SIZE), hasMore: false });

        const result = await fetchAllFiles(get);

        expect(result.data).toHaveLength(FILES_PAGE_SIZE + 3);
        expect(get).toHaveBeenNthCalledWith(1, `/api/v1/files?limit=${FILES_PAGE_SIZE}&offset=0`);
        expect(get).toHaveBeenNthCalledWith(2, `/api/v1/files?limit=${FILES_PAGE_SIZE}&offset=${FILES_PAGE_SIZE}`);
    });

    it('keeps going past a page the avatar filter shortened', async () => {
        const get = vi.fn()
            .mockResolvedValueOnce({ data: rows(FILES_PAGE_SIZE - 1), hasMore: true })
            .mockResolvedValueOnce({ data: rows(2, FILES_PAGE_SIZE), hasMore: false });

        const result = await fetchAllFiles(get);

        expect(get).toHaveBeenCalledTimes(2);
        expect(result.data).toHaveLength(FILES_PAGE_SIZE + 1);
    });

    it('passes the prefix through', async () => {
        const get = vi.fn().mockResolvedValueOnce({ data: [], hasMore: false });

        await fetchAllFiles(get, 'generated/');

        expect(get).toHaveBeenCalledWith(`/api/v1/files?limit=${FILES_PAGE_SIZE}&offset=0&prefix=generated%2F`);
    });

    it('stops on a short page from an API that predates hasMore', async () => {
        const get = vi.fn().mockResolvedValueOnce({ data: rows(50) });

        await fetchAllFiles(get);

        expect(get).toHaveBeenCalledTimes(1);
    });
});
