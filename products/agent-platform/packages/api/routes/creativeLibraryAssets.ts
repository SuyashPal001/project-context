import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { creativeLibraryAssets } from '@serverless-saas/agent-schema/creativeLibraryAssets';
import { storageService } from '@serverless-saas/storage';
import type { AppEnv } from '@serverless-saas/types';

const uuidSchema = z.string().uuid();

export const creativeLibraryAssetsRoutes = new Hono<AppEnv>();

// Deliberately not tenant-scoped — mounted on the normal secure `api`
// router (JWT-authenticated via authInjectionMiddleware, same as every
// other route in this file's section) but the lookup below ignores
// tenantId entirely, since a creative_library_assets row is platform
// data, not tenant data. `status = 'active'` still gates it so a
// retired preset 404s like a missing one, not like a broken one.
// Deliberately no permission check, unlike /files/:id/presigned-url's
// files:read requirement — a creative_library_assets row is platform
// data with no tenant owner to hold that grant against, so any
// authenticated user reaching this route is the whole access model.
creativeLibraryAssetsRoutes.get('/:id/presigned-url', async (c) => {
  const id = c.req.param('id');

  if (!uuidSchema.safeParse(id).success) {
    return c.json({ error: 'Not Found', message: 'Creative library asset not found' }, 404);
  }

  const [row] = await db
    .select({ storageKey: creativeLibraryAssets.storageKey })
    .from(creativeLibraryAssets)
    .where(and(
      eq(creativeLibraryAssets.id, id),
      eq(creativeLibraryAssets.status, 'active'),
      isNull(creativeLibraryAssets.tenantId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not Found', message: 'Creative library asset not found' }, 404);

  const presignedUrl = await storageService.getLibraryAssetDownloadUrl(row.storageKey);
  return c.json({ presignedUrl });
});
