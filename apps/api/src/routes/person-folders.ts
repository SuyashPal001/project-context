import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '@serverless-saas/database';
import { personFolders } from '@serverless-saas/database/schema';
import { eq, and } from 'drizzle-orm';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

const personFoldersRoutes = new Hono<AppEnv>();

// Create or upsert a person folder by identifier
personFoldersRoutes.post(
  '/',
  zValidator('json', z.object({ identifier: z.string().min(1).max(255) })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    const { identifier } = c.req.valid('json');

    const [existing] = await db
      .select({ id: personFolders.id })
      .from(personFolders)
      .where(and(eq(personFolders.tenantId, tenantId), eq(personFolders.identifier, identifier)))
      .limit(1);

    if (existing) {
      return c.json({ data: { id: existing.id } }, 200);
    }

    const [created] = await db
      .insert(personFolders)
      .values({ tenantId, identifier })
      .returning({ id: personFolders.id });

    return c.json({ data: { id: created.id } }, 201);
  }
);

// Look up a person folder by identifier
personFoldersRoutes.get('/lookup', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const identifier = c.req.query('identifier');
  if (!identifier) {
    return c.json({ error: 'Bad Request', message: 'identifier query param required' }, 400);
  }

  const [folder] = await db
    .select({ id: personFolders.id })
    .from(personFolders)
    .where(and(eq(personFolders.tenantId, tenantId), eq(personFolders.identifier, identifier)))
    .limit(1);

  if (!folder) {
    return c.json({ found: false });
  }

  return c.json({ found: true, data: { id: folder.id } });
});

// Delete a person folder
personFoldersRoutes.delete('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'delete')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:delete' }, 403);
  }

  const folderId = c.req.param('id');

  const [folder] = await db
    .select({ id: personFolders.id })
    .from(personFolders)
    .where(and(eq(personFolders.id, folderId), eq(personFolders.tenantId, tenantId)))
    .limit(1);

  if (!folder) {
    return c.json({ error: 'Not Found', message: 'Folder not found' }, 404);
  }

  await db
    .delete(personFolders)
    .where(and(eq(personFolders.id, folderId), eq(personFolders.tenantId, tenantId)));

  return c.json({ success: true });
});

export { personFoldersRoutes };
