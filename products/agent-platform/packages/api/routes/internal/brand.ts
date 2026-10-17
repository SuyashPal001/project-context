import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@serverless-saas/types';
import { isAuthorized } from './tasks.auth';
import { brandFillSchema } from '../../lib/brandSchema';
import { applyImportResult, getBrandRow, markImportFailed } from '../../lib/brandRecords';
import { importOneImage } from '../../lib/safeFetch';

export const internalBrandRoute = new Hono<AppEnv>();

const BRAND_IMAGE_PREFIX = 'brand/';
const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'));

const bodySchema = z.discriminatedUnion('ok', [
  z.object({
    tenantId: z.string().uuid(), ok: z.literal(true), fields: brandFillSchema,
    sourceText: z.string().max(20_000).default(''),
    logoUrl: httpsUrl.optional(), faviconUrl: httpsUrl.optional(),
  }),
  z.object({ tenantId: z.string().uuid(), ok: z.literal(false), error: z.string().max(500) }),
]);

async function saveImage(url: string | undefined, tenantId: string, userId: string | null): Promise<string | undefined> {
  if (!url || !userId) return undefined;
  try {
    return (await importOneImage(url, tenantId, userId, BRAND_IMAGE_PREFIX))?.fileId;
  } catch (error) {
    console.warn('[internal.brand] image not saved', { tenantId, url, error: (error as Error).message });
    return undefined;
  }
}

internalBrandRoute.post('/import-result', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  const row = await getBrandRow(body.tenantId);
  if (!row || row.importStatus !== 'importing') return c.json({ result: 'ignored' });

  if (!body.ok) {
    console.error('[internal.brand] import failed', { tenantId: body.tenantId, error: body.error });
    await markImportFailed(body.tenantId, body.error);
    return c.json({ result: 'failed' });
  }

  const [logoFileId, faviconFileId] = await Promise.all([
    saveImage(body.logoUrl, body.tenantId, row.createdBy),
    saveImage(body.faviconUrl, body.tenantId, row.createdBy),
  ]);
  const result = await applyImportResult(body.tenantId, body.fields, body.sourceText, { logoFileId, faviconFileId });
  return c.json({ result });
});
