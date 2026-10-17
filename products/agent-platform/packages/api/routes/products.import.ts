import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import { createDeadline, guardedFetch, importOneImage, readCapped, type ImportedImage } from '../lib/safeFetch';
import { extractProductPage } from '../lib/productPageExtract';
import { createProduct, PRODUCT_NAME_PLACEHOLDER } from '../lib/productRecords';
import { nameCreatedProduct } from '../lib/nameCreatedProduct';

export const productsImportRoutes = new Hono<AppEnv>();

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_IMAGE_FETCHES = 3;
const PAGE_FETCH_TIMEOUT_MS = 8000;
// Leave headroom under the web proxy's 15 s abort for the whole request.
const REQUEST_BUDGET_MS = 13_000;
const IMPORTED_IMAGE_PREFIX = 'imported-products/'; // deliberately outside creative-products/ — see CreativeLibrary.tsx's PRODUCT_PREFIX filter

productsImportRoutes.post(
  '/',
  zValidator('json', z.object({ url: z.string().url() })),
  async (c) => {
    const startedAt = Date.now();
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
    if (!userId) return c.json({ error: 'Forbidden', message: 'Missing userId' }, 403);

    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { url } = c.req.valid('json');
    if (!url.startsWith('https://')) {
      return c.json({ error: 'Import failed', message: 'Only https:// URLs are allowed' }, 400);
    }

    const deadline = createDeadline(PAGE_FETCH_TIMEOUT_MS);
    let pageResponse: Response;
    let html: string;
    try {
      try {
        pageResponse = await guardedFetch(url, deadline.signal);
      } catch (error) {
        // The guard's own message can name the resolved private address — log
        // it server-side, but never hand a tenant a probe for what resolves
        // where on the platform's network.
        console.error('[products.import] fetch failed', { url, error });
        return c.json({ error: 'Import failed', message: 'Could not read that product page' }, 422);
      }

      const contentType = pageResponse.headers.get('content-type') ?? '';
      if (!pageResponse.ok || !contentType.includes('text/html')) {
        return c.json({ error: 'Import failed', message: 'That URL is not a readable web page' }, 422);
      }

      try {
        html = (await readCapped(pageResponse, MAX_PAGE_BYTES, deadline.signal)).toString('utf8');
      } catch (error) {
        console.error('[products.import] page read failed', { url, error });
        return c.json({ error: 'Import failed', message: 'That page was too large or too slow to read' }, 422);
      }
    } finally {
      deadline.dispose();
    }

    const extracted = extractProductPage(html, pageResponse.url || url);

    // Best-effort, bounded concurrency: one bad image must not fail the
    // others, and allSettled (not all) is what makes that true.
    const images: ImportedImage[] = [];
    for (let i = 0; i < extracted.imageUrls.length; i += MAX_CONCURRENT_IMAGE_FETCHES) {
      const batch = extracted.imageUrls.slice(i, i + MAX_CONCURRENT_IMAGE_FETCHES);
      const results = await Promise.allSettled(batch.map((imageUrl) => importOneImage(imageUrl, tenantId, userId, IMPORTED_IMAGE_PREFIX)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) images.push(result.value);
      }
    }

    if (images.length === 0) {
      return c.json({ error: 'Import failed', message: 'No product images found on that page' }, 422);
    }

    const title = extracted.title?.trim().slice(0, 120) || null;
    const product = await createProduct({
      tenantId,
      createdBy: userId,
      name: title ?? PRODUCT_NAME_PLACEHOLDER,
      category: null,
      description: extracted.description?.trim() || null,
      price: extracted.price,
      usps: [],
      sourceUrl: url,
      imageFileIds: images.map((image) => image.fileId),
      namingStatus: title ? 'done' : 'pending',
    });

    // A title-less import is AI-named here, in the same request, with whatever
    // time is left before the web proxy's 15 s abort (page + image fetches
    // already spent some). Too little left → it returns pending and the
    // client's retry names it.
    const namingBudgetMs = Math.min(10_000, REQUEST_BUDGET_MS - (Date.now() - startedAt));
    return c.json({ data: await nameCreatedProduct(tenantId, product, namingBudgetMs) });
  },
);
