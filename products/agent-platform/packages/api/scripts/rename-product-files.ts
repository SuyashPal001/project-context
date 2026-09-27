// One-off: rename the photo files of already-named products after the product
// (display name only). Idempotent — unchanged names are skipped. Needs only
// DATABASE_URL. Run from the laptop:  pnpm rename:product-files
import { db } from '../db';
import { creativeProducts } from '@serverless-saas/agent-schema/creativeProducts';
import { renameProductFiles } from '../lib/productRecords';

type Row = { id: string; tenantId: string; name: string; imageFileIds: string[]; namingStatus: 'pending' | 'done' | 'failed' };

export function productsToRename(rows: Row[]): Row[] {
  return rows.filter((r) => r.namingStatus === 'done' && r.imageFileIds.length > 0);
}

async function main(): Promise<void> {
  const rows = await db.select({
    id: creativeProducts.id, tenantId: creativeProducts.tenantId, name: creativeProducts.name,
    imageFileIds: creativeProducts.imageFileIds, namingStatus: creativeProducts.namingStatus,
  }).from(creativeProducts);
  const todo = productsToRename(rows);
  console.log(`[rename-files] ${rows.length} products, ${todo.length} to rename`);
  for (const r of todo) {
    await renameProductFiles(r.tenantId, r.imageFileIds, r.name);
    console.log(`[rename-files] product=${r.id} "${r.name}" files=${r.imageFileIds.length}`);
  }
}

if (process.argv[1]?.includes('rename-product-files')) {
  main().then(() => process.exit(0)).catch((error) => { console.error('[rename-files] failed', error); process.exit(1); });
}
