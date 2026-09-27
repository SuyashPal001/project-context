import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeProducts, type CreativeProduct } from '@serverless-saas/agent-schema/creativeProducts';

export const PRODUCT_NAME_PLACEHOLDER = 'Untitled product';
export const ALLOWED_PRODUCT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ProductNamingStatus = 'pending' | 'done' | 'failed';
export interface ProductImage { fileId: string; name: string; type: string; size: number }
export interface ProductRecord {
  id: string;
  name: string;
  description: string | null;
  price: string | null;
  sourceUrl: string | null;
  namingStatus: ProductNamingStatus;
  images: ProductImage[];
  createdAt: string;
}

/** Escapes %, _ and \ so user search text matches literally inside ILIKE. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function toProductRecord(row: CreativeProduct, imagesById: Map<string, ProductImage>): ProductRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    sourceUrl: row.sourceUrl,
    namingStatus: row.namingStatus,
    images: row.imageFileIds.flatMap((fileId) => {
      const image = imagesById.get(fileId);
      return image ? [image] : [];
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadProductImages(tenantId: string, fileIds: string[]): Promise<Map<string, ProductImage>> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: files.id, name: files.name, mimeType: files.mimeType, size: files.size })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), inArray(files.id, unique), isNull(files.deletedAt)));
  return new Map(rows.map((r) => [r.id, { fileId: r.id, name: r.name, type: r.mimeType ?? 'image/png', size: r.size ?? 0 }]));
}

/** A product with no surviving image can't be attached to a brief, so lists hide it. */
export function dropImageless(records: ProductRecord[]): ProductRecord[] {
  return records.filter((p) => p.images.length > 0);
}

const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_FILE_NAME = 255; // files.name is varchar(255)

/** Display name for a product's photo: "<product>.<ext>", then "<product> (2).<ext>"… */
export function productFileName(productName: string, index: number, currentName: string, mimeType: string | null): string {
  const match = /\.[A-Za-z0-9]{1,5}$/.exec(currentName);
  const ext = match ? match[0].toLowerCase() : (EXT_BY_MIME[mimeType ?? ''] ?? '');
  const suffix = index === 0 ? '' : ` (${index + 1})`;
  const base = productName.trim().replace(/[/\\]/g, '-');
  return `${base.slice(0, MAX_FILE_NAME - suffix.length - ext.length).trimEnd()}${suffix}${ext}`;
}

/** Renames the product's photo files (display name only — never the S3 key) so
 *  the # picker, attachments, Drive and downloads show the product's name. */
export async function renameProductFiles(tenantId: string, imageFileIds: string[], productName: string): Promise<void> {
  if (imageFileIds.length === 0) return;
  const rows = await db
    .select({ id: files.id, name: files.name, mimeType: files.mimeType })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), inArray(files.id, imageFileIds), isNull(files.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  await Promise.all(imageFileIds.map((id, index) => {
    const file = byId.get(id);
    if (!file) return undefined;
    const name = productFileName(productName, index, file.name, file.mimeType);
    if (name === file.name) return undefined;
    return db.update(files).set({ name, updatedAt: new Date() }).where(and(eq(files.tenantId, tenantId), eq(files.id, id)));
  }));
}

/** The product name is the source of truth; a failed file rename is logged, never fatal. */
async function syncProductFileNames(tenantId: string, imageFileIds: string[], productName: string): Promise<void> {
  try {
    await renameProductFiles(tenantId, imageFileIds, productName);
  } catch (error) {
    console.error('[productRecords] renaming product files failed', { tenantId, error: (error as Error).message });
  }
}

export async function listProductImageFileIds(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ imageFileIds: creativeProducts.imageFileIds })
    .from(creativeProducts)
    .where(eq(creativeProducts.tenantId, tenantId));
  return [...new Set(rows.flatMap((r) => r.imageFileIds))];
}

async function withImages(tenantId: string, rows: CreativeProduct[]): Promise<ProductRecord[]> {
  const imagesById = await loadProductImages(tenantId, rows.flatMap((r) => r.imageFileIds));
  return dropImageless(rows.map((r) => toProductRecord(r, imagesById)));
}

export async function listProducts(tenantId: string, opts: { q?: string; limit: number; offset: number }): Promise<ProductRecord[]> {
  const q = opts.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const rows = await db
    .select()
    .from(creativeProducts)
    .where(and(
      eq(creativeProducts.tenantId, tenantId),
      pattern ? or(ilike(creativeProducts.name, pattern), ilike(creativeProducts.description, pattern)) : undefined,
    ))
    .orderBy(desc(creativeProducts.createdAt), desc(creativeProducts.id))
    .limit(opts.limit)
    .offset(opts.offset);
  return withImages(tenantId, rows);
}

export async function getProduct(tenantId: string, id: string): Promise<ProductRecord | null> {
  const [row] = await db
    .select()
    .from(creativeProducts)
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .limit(1);
  if (!row) return null;
  const imagesById = await loadProductImages(tenantId, row.imageFileIds);
  return toProductRecord(row, imagesById);
}

export async function createProduct(input: {
  tenantId: string; createdBy: string | null; name: string; description: string | null;
  price: string | null; sourceUrl: string | null; imageFileIds: string[]; namingStatus: ProductNamingStatus;
}): Promise<ProductRecord> {
  const [row] = await db.insert(creativeProducts).values(input).returning();
  if (row.namingStatus === 'done') await syncProductFileNames(input.tenantId, row.imageFileIds, row.name);
  const imagesById = await loadProductImages(input.tenantId, row.imageFileIds);
  return toProductRecord(row, imagesById);
}

export async function renameProduct(tenantId: string, id: string, name: string): Promise<ProductRecord | null> {
  // A user rename is final: naming_status becomes 'done' so an AI naming
  // result that lands later (applyNamingResult) can't overwrite it.
  const [row] = await db
    .update(creativeProducts)
    .set({ name, namingStatus: 'done' })
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .returning();
  if (!row) return null;
  await syncProductFileNames(tenantId, row.imageFileIds, row.name);
  return toProductRecord(row, await loadProductImages(tenantId, row.imageFileIds));
}

export async function deleteProduct(tenantId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(creativeProducts)
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .returning({ id: creativeProducts.id });
  return deleted.length > 0;
}

export async function applyNamingResult(
  tenantId: string, id: string, result: { name: string; description: string | null } | null,
): Promise<void> {
  // Only a still-pending product takes the AI result — see renameProduct.
  // COALESCE keeps a description the link import already found.
  const [updated] = await db
    .update(creativeProducts)
    .set(result
      ? { name: result.name, description: sql`coalesce(${creativeProducts.description}, ${result.description})`, namingStatus: 'done' as const }
      : { namingStatus: 'failed' as const })
    .where(and(
      eq(creativeProducts.tenantId, tenantId),
      eq(creativeProducts.id, id),
      eq(creativeProducts.namingStatus, 'pending'),
    ))
    .returning({ imageFileIds: creativeProducts.imageFileIds, name: creativeProducts.name });
  if (result && updated) await syncProductFileNames(tenantId, updated.imageFileIds, updated.name);
}
