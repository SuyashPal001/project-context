import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '@serverless-saas/database';
import { files, personFolders } from '@serverless-saas/database/schema';
import { hasPermission } from '@serverless-saas/permissions';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { AppEnv } from '../types';

const personFoldersRoutes = new Hono<AppEnv>();

// List all person folders for this tenant
personFoldersRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const rows = await db
    .select({
      id: personFolders.id,
      identifier: personFolders.identifier,
      displayName: personFolders.displayName,
      status: personFolders.status,
      createdAt: personFolders.createdAt,
      fileCount: sql<number>`count(${files.id}) filter (where ${files.deletedAt} is null and ${files.status} = 'uploaded')`.as('file_count'),
      pendingCount: sql<number>`count(${files.id}) filter (where ${files.deletedAt} is null and ${files.ingestionStatus} = 'pending')`.as('pending_count'),
    })
    .from(personFolders)
    .leftJoin(files, eq(files.personFolderId, personFolders.id))
    .where(eq(personFolders.tenantId, tenantId))
    .groupBy(personFolders.id)
    .orderBy(personFolders.createdAt);

  return c.json({ data: rows });
});

// Lookup a folder by identifier (used by chat agent)
personFoldersRoutes.get('/lookup', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const identifier = c.req.query('identifier')?.trim();

  if (!identifier) return c.json({ error: 'Bad Request', message: 'identifier required' }, 400);

  const [folder] = await db
    .select({ id: personFolders.id, identifier: personFolders.identifier, status: personFolders.status })
    .from(personFolders)
    .where(and(eq(personFolders.tenantId, tenantId), eq(personFolders.identifier, identifier)))
    .limit(1);

  if (!folder) return c.json({ found: false }, 200);
  return c.json({ found: true, data: folder });
});

// Create a person folder
personFoldersRoutes.post(
  '/',
  zValidator('json', z.object({
    identifier: z.string().min(1).max(255),
    displayName: z.string().max(255).optional(),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    const { identifier, displayName } = c.req.valid('json');

    const [existing] = await db
      .select({ id: personFolders.id })
      .from(personFolders)
      .where(and(eq(personFolders.tenantId, tenantId), eq(personFolders.identifier, identifier)))
      .limit(1);

    if (existing) {
      return c.json({ data: { id: existing.id, existing: true } }, 200);
    }

    const [folder] = await db
      .insert(personFolders)
      .values({ tenantId, identifier, displayName: displayName ?? null, createdBy: userId as string })
      .returning({ id: personFolders.id, identifier: personFolders.identifier, status: personFolders.status });

    return c.json({ data: folder }, 201);
  }
);

// Verify a folder (admin action — marks documents ready for ingestion)
personFoldersRoutes.post('/:id/verify', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const folderId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'create')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
  }

  const [updated] = await db
    .update(personFolders)
    .set({ status: 'verified', updatedAt: new Date() })
    .where(and(eq(personFolders.id, folderId), eq(personFolders.tenantId, tenantId), eq(personFolders.status, 'pending')))
    .returning({ id: personFolders.id });

  if (!updated) return c.json({ error: 'Not Found or already verified' }, 404);
  return c.json({ success: true });
});

// Delete a person folder record
personFoldersRoutes.delete('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const folderId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'delete')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:delete' }, 403);
  }

  const deleted = await db
    .delete(personFolders)
    .where(and(eq(personFolders.id, folderId), eq(personFolders.tenantId, tenantId)))
    .returning({ id: personFolders.id });

  if (!deleted.length) return c.json({ error: 'Not Found' }, 404);
  return c.json({ success: true });
});

// List files in a person folder
personFoldersRoutes.get('/:id/files', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const folderId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const [folder] = await db
    .select({ id: personFolders.id })
    .from(personFolders)
    .where(and(eq(personFolders.id, folderId), eq(personFolders.tenantId, tenantId)))
    .limit(1);

  if (!folder) return c.json({ error: 'Not Found' }, 404);

  const fileRows = await db
    .select({ id: files.id, name: files.name, ingestionStatus: files.ingestionStatus, size: files.size, createdAt: files.createdAt })
    .from(files)
    .where(and(eq(files.personFolderId, folderId), eq(files.tenantId, tenantId), isNull(files.deletedAt), eq(files.status, 'uploaded')))
    .orderBy(files.createdAt);

  return c.json({ data: fileRows });
});

export { personFoldersRoutes };
