import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import { db } from '../db';
import { creativeLibraryAssets } from '@serverless-saas/agent-schema/creativeLibraryAssets';
import { storageService } from '@serverless-saas/storage';
import type { AppEnv } from '@serverless-saas/types';
import {
  AVATAR_PREFIX, getTenantAvatar, listTenantAvatars, nameTenantAvatarWithin, syncTenantAvatars,
  setAvatarReference, setAvatarSource, findTenantAvatarBySource,
} from '../lib/avatarRecords';

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
      // 'reference' rows are an avatar's reference sheet: fetchable as an
      // image reference, never listed as a pickable preset.
      inArray(creativeLibraryAssets.status, ['active', 'reference']),
      isNull(creativeLibraryAssets.tenantId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not Found', message: 'Creative library asset not found' }, 404);

  const presignedUrl = await storageService.getLibraryAssetDownloadUrl(row.storageKey);
  return c.json({ presignedUrl });
});

// ── The tenant's own avatars ────────────────────────────────────────────────
// Rows with tenant_id set. Their bytes are ordinary files under the Avatars
// folder, so the same files permissions guard them as guard Drive.

// Kept under the web proxy's 15 s abort; past it the avatar comes back still
// pending and the picker's retry names it.
const INLINE_NAMING_BUDGET_MS = 10_000;

function guard(c: Context<AppEnv>, action: 'read' | 'create'): string | Response {
  const requestContext = c.get('requestContext') as any;
  const tenantId: string | undefined = requestContext?.tenant?.id;
  if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  if (!hasPermission(requestContext?.permissions ?? [], 'files', action)) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }
  return tenantId;
}

const avatarNotFound = (c: Context<AppEnv>) => c.json({ error: 'Not Found', message: 'Avatar not found' }, 404);

creativeLibraryAssetsRoutes.get('/avatars', async (c) => {
  const tenantId = guard(c, 'read');
  if (tenantId instanceof Response) return tenantId;
  return c.json({ data: await listTenantAvatars(tenantId) });
});

// Registered above /avatars/:id-shaped routes so a literal "by-source"
// segment is never swallowed by an :id param matcher.
creativeLibraryAssetsRoutes.get('/avatars/by-source/:fileId', async (c) => {
  const tenantId = guard(c, 'read');
  if (tenantId instanceof Response) return tenantId;
  const fileId = c.req.param('fileId');
  if (!uuidSchema.safeParse(fileId).success) return avatarNotFound(c);
  const avatar = await findTenantAvatarBySource(tenantId, fileId);
  if (!avatar) return avatarNotFound(c);
  return c.json({ data: avatar });
});

// Registers a just-uploaded Avatars-folder image and names it in the same
// request, so the picker can attach it under its new name straight away.
// An optional sourceFileId (e.g. a generated portrait the user kept as an
// avatar) is merged into attributes before naming, so a later by-source
// lookup for the same source file resolves to this avatar idempotently.
creativeLibraryAssetsRoutes.post(
  '/avatars',
  zValidator('json', z.object({ fileId: uuidSchema, sourceFileId: uuidSchema.optional(), category: z.enum(['UGC', 'Animation', 'TVC']).optional() })),
  async (c) => {
    const tenantId = guard(c, 'create');
    if (tenantId instanceof Response) return tenantId;
    const { fileId, sourceFileId, category } = c.req.valid('json');
    await syncTenantAvatars(tenantId);
    const avatar = await getTenantAvatar(tenantId, { fileId });
    // Not found covers another tenant's file, a non-image, and a file outside
    // the Avatars folder — sync only registers the tenant's own avatar images.
    if (!avatar) return c.json({ error: 'Invalid avatar', message: `The file must be your own JPG, PNG or WebP image under ${AVATAR_PREFIX}` }, 400);
    if (sourceFileId || category) await setAvatarSource(tenantId, avatar.id, sourceFileId, category);
    return c.json({ data: await nameTenantAvatarWithin(tenantId, avatar, INLINE_NAMING_BUDGET_MS) }, 201);
  },
);

// Finishes naming an avatar that came back pending (budget ran out, or it
// arrived through Drive's plain upload).
creativeLibraryAssetsRoutes.post('/avatars/:id/describe', async (c) => {
  const tenantId = guard(c, 'create');
  if (tenantId instanceof Response) return tenantId;
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return avatarNotFound(c);
  const avatar = await getTenantAvatar(tenantId, { id });
  if (!avatar) return avatarNotFound(c);
  return c.json({ data: await nameTenantAvatarWithin(tenantId, avatar, INLINE_NAMING_BUDGET_MS) });
});

// Director's save_as_avatar pins the identity sheet here after copying it
// into avatar-refs/. Later generations add the sheet automatically whenever
// this avatar's portrait is a reference (orchestrator avatarReferences.ts).
creativeLibraryAssetsRoutes.put(
  '/avatars/:id/reference',
  zValidator('json', z.object({
    referenceSheetFileId: uuidSchema,
    terseTag: z.string().trim().min(1).max(200),
    styleLock: z.string().trim().min(1).max(200),
    category: z.enum(['UGC', 'Animation', 'TVC']).optional(),
  })),
  async (c) => {
    const tenantId = guard(c, 'create');
    if (tenantId instanceof Response) return tenantId;
    const id = c.req.param('id');
    if (!uuidSchema.safeParse(id).success) return avatarNotFound(c);
    const result = await setAvatarReference(tenantId, id, c.req.valid('json'));
    if (result === null) return avatarNotFound(c);
    if (result === 'invalid_sheet') return c.json({ error: 'Invalid sheet', message: 'The sheet must be your own image under avatar-refs/' }, 400);
    return c.json({ data: result });
  },
);
