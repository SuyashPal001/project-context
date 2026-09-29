// One-off: turns loose images under creative-products/ into creative_products
// rows (one product per file), AI-named. Idempotent — files already referenced
// by a product are skipped. Needs DATABASE_URL, AWS credentials for S3,
// AGENT_ORCHESTRATOR_URL and INTERNAL_SERVICE_KEY.
//   pnpm backfill:creative-products
import { and, isNull, like } from 'drizzle-orm';
import { db } from '../db';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeProducts } from '@serverless-saas/agent-schema/creativeProducts';
import { ALLOWED_PRODUCT_IMAGE_TYPES, PRODUCT_NAME_PLACEHOLDER, createProduct } from '../lib/productRecords';
import { nameProduct } from '../lib/productNaming';

type CandidateFile = { id: string; tenantId: string; uploadedBy: string | null; mimeType: string | null };

export function selectBackfillCandidates(rows: CandidateFile[], referencedIds: Set<string>): CandidateFile[] {
  return rows.filter((row) => !referencedIds.has(row.id) && ALLOWED_PRODUCT_IMAGE_TYPES.has(row.mimeType ?? ''));
}

async function main(): Promise<void> {
  const rows = await db
    .select({ id: files.id, tenantId: files.tenantId, uploadedBy: files.uploadedBy, mimeType: files.mimeType })
    .from(files)
    .where(and(like(files.key, 'creative-products/%'), isNull(files.deletedAt)));
  const products = await db.select({ imageFileIds: creativeProducts.imageFileIds }).from(creativeProducts);
  const referenced = new Set(products.flatMap((p) => p.imageFileIds));
  const candidates = selectBackfillCandidates(rows, referenced);
  console.log(`[backfill] ${rows.length} files under creative-products/, ${candidates.length} to convert`);

  for (const file of candidates) {
    const product = await createProduct({
      tenantId: file.tenantId, createdBy: file.uploadedBy, name: PRODUCT_NAME_PLACEHOLDER, category: null, description: null,
      price: null, sourceUrl: null, usps: [], imageFileIds: [file.id], namingStatus: 'pending',
    });
    const named = await nameProduct(file.tenantId, product.id);
    console.log(`[backfill] file=${file.id} -> product=${product.id} name="${named?.name}" status=${named?.namingStatus}`);
  }
}

// Run only when executed directly, so the test can import selectBackfillCandidates.
if (process.argv[1]?.includes('backfill-creative-products')) {
  main().then(() => process.exit(0)).catch((error) => { console.error('[backfill] failed', error); process.exit(1); });
}
