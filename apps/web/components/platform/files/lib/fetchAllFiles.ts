/** Matches the API's MAX_LIST_LIMIT (apps/api/src/routes/files.listPage.ts). */
export const FILES_PAGE_SIZE = 500;

type FilesPage<T> = { data: T[]; hasMore?: boolean };

/** Every file the tenant has, page by page. GET /files returns one page (50 by
 *  default), and Drive builds its folders and pills from the full list — a
 *  single unpaged call left everything past the first page invisible, which
 *  hid new agent output once a tenant passed 50 files. Returns `{ data }`, the
 *  shape the shared ['files', ...] cache entries already hold. */
export async function fetchAllFiles<T>(
    get: (path: string) => Promise<FilesPage<T>>,
    prefix?: string,
): Promise<{ data: T[] }> {
    const all: T[] = [];
    for (let offset = 0; ; offset += FILES_PAGE_SIZE) {
        const params = new URLSearchParams({ limit: String(FILES_PAGE_SIZE), offset: String(offset) });
        if (prefix) params.set('prefix', prefix);
        const page = await get(`/api/v1/files?${params.toString()}`);
        const rows = page.data ?? [];
        all.push(...rows);
        // An API without hasMore (mid-deploy) is done once a page comes back short.
        if (!(page.hasMore ?? rows.length === FILES_PAGE_SIZE)) break;
    }
    return { data: all };
}
