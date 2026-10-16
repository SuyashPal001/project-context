import { and, eq, inArray } from 'drizzle-orm';
import { files } from '@serverless-saas/database/schema/storage';
import { db } from '../db';

/** True when every id is a files row of this tenant (a logo can't point at another workspace's file). */
export async function filesBelongToTenant(tenantId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const rows = await db.select({ id: files.id }).from(files).where(and(eq(files.tenantId, tenantId), inArray(files.id, ids)));
  return rows.length === new Set(ids).size;
}
