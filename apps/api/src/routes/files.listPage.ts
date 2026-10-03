/**
 * Page parsing for GET /files, kept free of Hono so it can be tested alone.
 *
 * Drive builds its folders and pills from the whole tenant list, so it walks
 * pages until a short one comes back. The cap keeps any single request bounded.
 */

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export function parseListPage(limitRaw: string | undefined, offsetRaw: string | undefined): { limit: number; offset: number } {
  const limit = Number.parseInt(limitRaw ?? '', 10);
  const offset = Number.parseInt(offsetRaw ?? '', 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}
