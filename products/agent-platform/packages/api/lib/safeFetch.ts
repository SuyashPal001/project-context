import { storageService } from '@serverless-saas/storage';
import { assertPublicHttpUrl, SsrfBlockedError } from '@serverless-saas/agent-worker-handlers/lib/ssrf-guard';

const MAX_REDIRECTS = 3; // matches the shared guard's own redirect budget
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * One deadline for a whole top-level request: every redirect hop AND the
 * subsequent body read share the same signal, so the budget is one
 * `timeoutMs`, not one per hop and not "until headers arrive". The caller
 * must call `dispose()` only after it has finished reading the body.
 */
export function createDeadline(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
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
export async function guardedFetch(rawUrl: string, signal: AbortSignal): Promise<Response> {
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

export async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
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

export interface ImportedImage { fileId: string; name: string; type: string; size: number }

// files.name is varchar(255) and files.key varchar(512): an unbounded remote
// filename would fail the insert AFTER the S3 put, orphaning the object.
function safeFilename(segment: string): string {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep raw segment */ }
  return decoded.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'image';
}

export async function importOneImage(
  imageUrl: string,
  tenantId: string,
  userId: string,
  prefix: string,
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
  const filename = safeFilename(new URL(imageUrl).pathname.split('/').pop() ?? '');
  const key = `${prefix}${crypto.randomUUID()}-${filename}`;
  const { fileId } = await storageService.putFileForTenant(tenantId, userId, key, body, contentType);
  return { fileId, name: filename, type: contentType, size: body.length };
}

/** One guarded GET for a text resource. Null on any failure (logged, never thrown). */
export async function fetchText(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; accept: (contentType: string) => boolean },
): Promise<{ text: string; finalUrl: string } | null> {
  const deadline = createDeadline(opts.timeoutMs);
  try {
    const response = await guardedFetch(url, deadline.signal);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !opts.accept(contentType)) {
      console.warn('[safeFetch] unreadable response', { url, status: response.status, contentType });
      return null;
    }
    const body = await readCapped(response, opts.maxBytes, deadline.signal);
    return { text: body.toString('utf8'), finalUrl: response.url || url };
  } catch (error) {
    console.warn('[safeFetch] fetch failed', { url, error: (error as Error).message });
    return null;
  } finally {
    deadline.dispose();
  }
}
