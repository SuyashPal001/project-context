import { Hono } from 'hono';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';
import {
  createPage,
  listPages,
  getPage,
  archivePage,
  toggleLock,
  listVersions,
  duplicatePage,
} from '../services/pageService.js';
import { savePage, restoreVersion } from '../services/pageSaveService.js';

export const pagesRoutes = new Hono<AppEnv>();

// POST /pages
pagesRoutes.post('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'create'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const result = z.object({
    planId: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    pageType: z.enum(['prd', 'roadmap', 'runbook', 'adr', 'handover', 'manual', 'custom']).optional(),
    parentId: z.string().uuid().optional(),
    access: z.number().int().min(0).max(1).optional(),
  }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

  const page = await createPage(tenantId, userId, result.data.planId, result.data);
  return c.json({ data: page }, 201);
});

// GET /pages?planId=
pagesRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'read'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const planId = c.req.query('planId');
  if (!planId) return c.json({ error: 'planId query param is required' }, 400);

  const pages = await listPages(tenantId, planId);
  return c.json({ data: pages });
});

// GET /pages/:id
pagesRoutes.get('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'read'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const page = await getPage(tenantId, c.req.param('id'));
  if (!page) return c.json({ error: 'Page not found' }, 404);
  return c.json({ data: page });
});

// PATCH /pages/:id — lock check: locked page rejects non-owner edits
pagesRoutes.patch('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'update'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const pageId = c.req.param('id');
  const existing = await getPage(tenantId, pageId);
  if (!existing) return c.json({ error: 'Page not found' }, 404);
  if (existing.isLocked && existing.ownedBy !== userId)
    return c.json({ error: 'Page is locked', code: 'PAGE_LOCKED' }, 403);

  const result = z.object({
    title: z.string().min(1).max(500).optional(),
    descriptionHtml: z.string().optional(),
    descriptionJson: z.record(z.unknown()).optional(),
  }).safeParse(await c.req.json());
  if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

  const page = await savePage(tenantId, userId, pageId, result.data);
  return c.json({ data: page });
});

// DELETE /pages/:id — soft delete via archived_at
pagesRoutes.delete('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'delete'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const pageId = c.req.param('id');
  const existing = await getPage(tenantId, pageId);
  if (!existing) return c.json({ error: 'Page not found' }, 404);

  await archivePage(tenantId, pageId);
  return c.json({ success: true });
});

// GET /pages/:id/versions
pagesRoutes.get('/:id/versions', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'read'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const pageId = c.req.param('id');
  const existing = await getPage(tenantId, pageId);
  if (!existing) return c.json({ error: 'Page not found' }, 404);

  const versions = await listVersions(tenantId, pageId);
  return c.json({ data: versions });
});

// POST /pages/:id/restore/:versionId
pagesRoutes.post('/:id/restore/:versionId', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'update'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const { id: pageId, versionId } = c.req.param();
  const existing = await getPage(tenantId, pageId);
  if (!existing) return c.json({ error: 'Page not found' }, 404);
  if (existing.isLocked && existing.ownedBy !== userId)
    return c.json({ error: 'Page is locked', code: 'PAGE_LOCKED' }, 403);

  const page = await restoreVersion(tenantId, userId, pageId, versionId);
  return c.json({ data: page });
});

// POST /pages/:id/duplicate
pagesRoutes.post('/:id/duplicate', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'create'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const pageId = c.req.param('id');
  try {
    const page = await duplicatePage(tenantId, userId, pageId);
    return c.json({ data: page }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Page not found')
      return c.json({ error: 'Page not found' }, 404);
    throw err;
  }
});

// POST /pages/:id/lock — toggles is_locked
pagesRoutes.post('/:id/lock', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'project_pages', 'update'))
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const pageId = c.req.param('id');
  const existing = await getPage(tenantId, pageId);
  if (!existing) return c.json({ error: 'Page not found' }, 404);

  const page = await toggleLock(tenantId, userId, pageId);
  return c.json({ data: page });
});
