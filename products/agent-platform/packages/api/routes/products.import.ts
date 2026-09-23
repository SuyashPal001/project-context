import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { storageService } from '@serverless-saas/storage';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import { assertPublicHttpUrl, SsrfBlockedError } from '@serverless-saas/agent-worker-handlers/lib/ssrf-guard';
import { extractProductPage } from '../lib/productPageExtract';

export const productsImportRoutes = new Hono<AppEnv>();

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_IMAGE_FETCHES = 3;
const PAGE_FETCH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3; // matches the shared guard's own redirect budget
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMPORTED_IMAGE_PREFIX = 'imported-products/'; // deliberately outside creative-products/ — see CreativeLibrary.tsx's PRODUCT_PREFIX filter

/**
 * One deadline for a whole top-level request: every redirect hop AND the
 * subsequent body read share the same signal, so the budget is one
 * `timeoutMs`, not one per hop and not "until headers arrive". The caller
 * must call `dispose()` only after it has finished reading the body.
 */
function createDeadline(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/**
 * Fetches with `redirect: 'manual'` and re-runs the shared SSRF guard on
 * every redirect target, rejecting past MAX_REDIRECTS. `fetch()`'s default
 * `redirect: 'follow'` would only ever have guarded the first URL — a
 * same-origin page that 302s to an internal address would sail through.
 * This route additionally requires https — the shared guard allows http too.
 *
 * The caller-supplied `signal` is passed to every hop's fetch; pass the same
 * signal to readCapped so the body read shares the deadline.
 */
async function guardedFetch(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!currentUrl.startsWith('https://')) {
      throw new SsrfBlockedError(`Only https:// URLs are allowed: ${currentUrl}`);
    }
    await assertPublicHttpUrl(currentUrl);
    const response = await fetch(currentUrl, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError(`Too many redirects fetching ${rawUrl}`);
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Read aborted: deadline exceeded'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {}); // avoid an unhandled rejection when the read finishes first
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

interface ImportedImage { fileId: string; name: string; type: string; size: number }

async function importOneImage(
  imageUrl: string,
  tenantId: string,
  userId: string,
): Promise<ImportedImage | null> {
  const deadline = createDeadline(IMAGE_FETCH_TIMEOUT_MS);
  let body: Buffer;
  let contentType: string;
  try {
    const response = await guardedFetch(imageUrl, deadline.signal);
    contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !ALLOWED_IMAGE_TYPES.has(contentType)) return null;
    body = await readCapped(response, MAX_IMAGE_BYTES, deadline.signal);
  } finally {
    deadline.dispose();
  }
  const filename = new URL(imageUrl).pathname.split('/').pop() || 'image';
  const key = `${IMPORTED_IMAGE_PREFIX}${crypto.randomUUID()}-${filename}`;
  const { fileId } = await storageService.putFileForTenant(tenantId, userId, key, body, contentType);
  return { fileId, name: filename, type: contentType, size: body.length };
}

productsImportRoutes.post(
  '/',
  zValidator('json', z.object({ url: z.string().url() })),
  async (c) => {
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
      const results = await Promise.allSettled(batch.map((imageUrl) => importOneImage(imageUrl, tenantId, userId)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) images.push(result.value);
      }
    }

    return c.json({
      data: {
        title: extracted.title,
        description: extracted.description,
        price: extracted.price,
        images,
      },
    });
  },
);
