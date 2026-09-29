import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import {
  ALLOWED_PRODUCT_IMAGE_TYPES, PRODUCT_NAME_PLACEHOLDER,
  createProduct, deleteProduct, getProduct, listProducts, listProductImageFileIds, loadProductImages, updateProduct,
} from '../lib/productRecords';
import { PRODUCT_CATEGORIES } from '../lib/productCategories';
import { nameCreatedProduct } from '../lib/nameCreatedProduct';
import { deleteUnusedProductFiles } from '../lib/productFileCleanup';

export const productsRoutes = new Hono<AppEnv>();

const uuid = z.string().uuid();
const MAX_IMAGES = 6;
// Kept well under the web proxy's 15 s abort; past it the product returns
// still pending and the client's retry names it.
const INLINE_NAMING_BUDGET_MS = 10_000;

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

const createProductSchema = z.object({
  fileIds: z.array(uuid).max(MAX_IMAGES).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(PRODUCT_CATEGORIES).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional().transform(v => v === '' ? null : v),
  usps: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
}).refine(
  (data) => (data.fileIds?.length ?? 0) > 0 || (data.name?.trim().length ?? 0) > 0,
  { message: 'Give the product a name or add at least one photo' },
);

productsRoutes.post(
  '/',
  zValidator('json', createProductSchema),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const body = c.req.valid('json');
    const fileIds = [...new Set(body.fileIds ?? [])];
    if (fileIds.length > 0) {
      const images = await loadProductImages(g.tenantId, fileIds);
      const valid = fileIds.every((id) => ALLOWED_PRODUCT_IMAGE_TYPES.has(images.get(id)?.type ?? ''));
      if (!valid) return c.json({ error: 'Invalid images', message: 'Every file must be your own JPG, PNG or WebP image' }, 400);
    }
    // A name given directly is final, same rule updateProduct applies to an
    // edit: naming_status is 'done' and AI naming never runs. Naming only
    // kicks in for the photo-drop path, which has no name to give yet.
    const name = body.name ?? PRODUCT_NAME_PLACEHOLDER;
    const namingStatus = body.name ? 'done' : 'pending';
    const product = await createProduct({
      tenantId: g.tenantId, createdBy: g.userId, name, category: body.category ?? null,
      description: body.description ?? null, price: null, sourceUrl: null, usps: body.usps ?? [],
      imageFileIds: fileIds, namingStatus,
    });
    return c.json({ data: await nameCreatedProduct(g.tenantId, product, INLINE_NAMING_BUDGET_MS) }, 201);
  },
);

productsRoutes.post('/:id/describe', async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) return notFound(c);
  const product = await getProduct(g.tenantId, id);
  if (!product) return notFound(c);
  // Same budget as create: past it the product comes back still pending rather
  // than the web proxy's 15 s abort turning a slow naming into a 504.
  return c.json({ data: await nameCreatedProduct(g.tenantId, product, INLINE_NAMING_BUDGET_MS) });
});

const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(PRODUCT_CATEGORIES).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional().transform(v => v === '' ? null : v),
  usps: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
  imageFileIds: z.array(uuid).max(MAX_IMAGES).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update' },
);

productsRoutes.patch(
  '/:id',
  zValidator('json', updateProductSchema),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) return notFound(c);
    const body = c.req.valid('json');
    if (body.imageFileIds) {
      const uniqueIds = [...new Set(body.imageFileIds)];
      const images = await loadProductImages(g.tenantId, uniqueIds);
      const valid = uniqueIds.every((imgId) => ALLOWED_PRODUCT_IMAGE_TYPES.has(images.get(imgId)?.type ?? ''));
      if (!valid) return c.json({ error: 'Invalid images', message: 'Every file must be your own JPG, PNG or WebP image' }, 400);
      body.imageFileIds = uniqueIds;
    }
    const product = await updateProduct(g.tenantId, id, body);
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
