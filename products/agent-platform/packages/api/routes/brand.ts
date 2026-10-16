import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import { brandPatchSchema } from '../lib/brandSchema';
import { getBrand, patchBrand } from '../lib/brandRecords';
import { parseBrandSource } from '../lib/brandSource';
import { runBrandImport } from '../lib/brandImport';
import { filesBelongToTenant } from '../lib/brandFiles';

export const brandRoutes = new Hono<AppEnv>();

// Brand images are Drive files, so the brand follows the files permissions, like products.
function guard(c: Context<AppEnv>, action: 'read' | 'create'): { tenantId: string; userId: string } | Response {
  const requestContext = c.get('requestContext') as any;
  const tenantId: string | undefined = requestContext?.tenant?.id;
  const userId = c.get('userId') as string | undefined;
  if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  if (!userId) return c.json({ error: 'Forbidden', message: 'Missing userId' }, 403);
  if (!hasPermission(requestContext?.permissions ?? [], 'files', action)) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }
  return { tenantId, userId };
}

brandRoutes.get('/', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: await getBrand(g.tenantId) });
});

brandRoutes.patch('/', zValidator('json', brandPatchSchema), async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const patch = c.req.valid('json');
  const fileIds = [patch.logoFileId, patch.faviconFileId, patch.mascotFileId].filter((v): v is string => typeof v === 'string');
  if (!(await filesBelongToTenant(g.tenantId, fileIds))) {
    return c.json({ error: 'Invalid file', message: 'That image is not in this workspace' }, 400);
  }
  await patchBrand(g.tenantId, g.userId, patch);
  return c.json({ data: await getBrand(g.tenantId) });
});

brandRoutes.post('/import', zValidator('json', z.object({ value: z.string().max(500) })), async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const source = parseBrandSource(c.req.valid('json').value);
  if (!source) return c.json({ error: 'Import failed', message: 'Paste a website link or an Instagram handle' }, 400);
  await runBrandImport(g.tenantId, g.userId, source);
  return c.json({ data: await getBrand(g.tenantId) }, 202);
});
