import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import {
  ALLOWED_PRODUCT_IMAGE_TYPES, PRODUCT_NAME_PLACEHOLDER,
  createProduct, deleteProduct, listProducts, listProductImageFileIds, loadProductImages, renameProduct,
} from '../lib/productRecords';
import { nameProduct } from '../lib/productNaming';
import { nameCreatedProduct } from '../lib/nameCreatedProduct';
import { deleteUnusedProductFiles } from '../lib/productFileCleanup';

export const productsRoutes = new Hono<AppEnv>();

const uuid = z.string().uuid();
const MAX_IMAGES = 6;

type Action = 'read' | 'create' | 'delete';

/** Resolves the tenant and checks a files permission. Returns the tenant id or a response to return. */
function guard(c: Context<AppEnv>, action: Action): { tenantId: string; userId: string | null } | Response {
  const requestContext = c.get('requestContext') as any;
  const tenantId: string | undefined = requestContext?.tenant?.id;
  if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  if (!hasPermission(requestContext?.permissions ?? [], 'files', action)) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }
  return { tenantId, userId: (c.get('userId') as string | undefined) ?? null };
}

const notFound = (c: Context<AppEnv>) => c.json({ error: 'Not Found', message: 'Product not found' }, 404);

productsRoutes.get('/', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const q = c.req.query('q') ?? undefined;
  const data = await listProducts(g.tenantId, { q, limit, offset });
  return c.json({ data });
});

// Every image file a product uses — Drive's Uploads view needs it to show a
// product photo there only once no product references it anymore.
productsRoutes.get('/image-file-ids', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: await listProductImageFileIds(g.tenantId) });
});

productsRoutes.post(
  '/',
  zValidator('json', z.object({ fileIds: z.array(uuid).min(1).max(MAX_IMAGES) })),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const fileIds = [...new Set(c.req.valid('json').fileIds)];
    const images = await loadProductImages(g.tenantId, fileIds);
    const valid = fileIds.every((id) => ALLOWED_PRODUCT_IMAGE_TYPES.has(images.get(id)?.type ?? ''));
    if (!valid) return c.json({ error: 'Invalid images', message: 'Every file must be your own JPG, PNG or WebP image' }, 400);
    const product = await createProduct({
      tenantId: g.tenantId, createdBy: g.userId, name: PRODUCT_NAME_PLACEHOLDER, description: null,
      price: null, sourceUrl: null, imageFileIds: fileIds, namingStatus: 'pending',
    });
    return c.json({ data: await nameCreatedProduct(g.tenantId, product) }, 201);
  },
);

productsRoutes.post('/:id/describe', async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) return notFound(c);
  const product = await nameProduct(g.tenantId, id);
  return product ? c.json({ data: product }) : notFound(c);
});

productsRoutes.patch(
  '/:id',
  zValidator('json', z.object({ name: z.string().trim().min(1).max(120) })),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) return notFound(c);
    const product = await renameProduct(g.tenantId, id, c.req.valid('json').name);
    return product ? c.json({ data: product }) : notFound(c);
  },
);

productsRoutes.delete('/:id', async (c) => {
  const g = guard(c, 'delete');
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) return notFound(c);
  const imageFileIds = await deleteProduct(g.tenantId, id);
  if (imageFileIds === null) return notFound(c);
  // The product is gone either way; a failed photo cleanup is logged, not fatal.
  try {
    await deleteUnusedProductFiles({
      tenantId: g.tenantId, fileIds: imageFileIds, actorId: g.userId, traceId: (c.get('traceId') as string | undefined) ?? '',
      ipAddress: c.get('clientIp') as string | undefined,
    });
  } catch (error) {
    console.error('[products] deleting product photos failed', { tenantId: g.tenantId, productId: id, error: (error as Error).message });
  }
  return c.body(null, 204);
});
